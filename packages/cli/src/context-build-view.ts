import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { KtxCliIo } from './index.js';
import type {
  KtxPublicIngestArgs,
  KtxPublicIngestPlanTarget,
  KtxPublicIngestProject,
  KtxPublicIngestTargetResult,
} from './public-ingest.js';
import { buildPublicIngestPlan, executePublicIngestTarget } from './public-ingest.js';
import { formatDuration } from './demo-metrics.js';
import { profileMark } from './startup-profile.js';

profileMark('module:context-build-view');

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const ESC = String.fromCharCode(0x1b);

export interface ContextBuildTargetState {
  target: KtxPublicIngestPlanTarget;
  status: 'queued' | 'running' | 'done' | 'failed';
  detailLine: string | null;
  summaryText: string | null;
  startedAt: number | null;
  elapsedMs: number;
}

export interface ContextBuildViewState {
  primarySources: ContextBuildTargetState[];
  contextSources: ContextBuildTargetState[];
  frame: number;
}

export interface ContextBuildArgs {
  projectDir: string;
  inputMode: 'auto' | 'disabled';
  scanMode?: 'structural' | 'enriched';
  detectRelationships?: boolean;
}

export interface ContextBuildResult {
  exitCode: number;
  detached: boolean;
}

export interface ContextBuildDeps {
  executeTarget?: typeof executePublicIngestTarget;
  now?: () => number;
  setupKeystroke?: (onDetach: () => void, onCtrlC: () => void) => (() => void) | null;
  onDetach?: () => void;
}

// --- Rendering ---

function green(text: string): string {
  return `${ESC}[32m${text}${ESC}[39m`;
}

function red(text: string): string {
  return `${ESC}[31m${text}${ESC}[39m`;
}

function cyan(text: string): string {
  return `${ESC}[36m${text}${ESC}[39m`;
}

function dim(text: string): string {
  return `${ESC}[2m${text}${ESC}[22m`;
}

function statusIcon(status: ContextBuildTargetState['status'], frame: number, styled: boolean): string {
  if (!styled) {
    switch (status) {
      case 'done':
        return '✓';
      case 'failed':
        return '✗';
      case 'running':
        return SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? '⠋';
      default:
        return '·';
    }
  }
  switch (status) {
    case 'done':
      return green('✓');
    case 'failed':
      return red('✗');
    case 'running':
      return cyan(SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? '⠋');
    default:
      return dim('·');
  }
}

function targetDetail(target: ContextBuildTargetState, styled: boolean): string {
  if (target.status === 'done') {
    const parts: string[] = [];
    if (target.summaryText) parts.push(target.summaryText);
    parts.push(formatDuration(target.elapsedMs));
    return parts.join(' · ');
  }
  if (target.status === 'failed') {
    return styled ? red('failed') : 'failed';
  }
  if (target.status === 'running') {
    return target.detailLine ?? (target.target.operation === 'scan' ? 'scanning...' : 'ingesting...');
  }
  return styled ? dim('queued') : 'queued';
}

function columnWidth(state: ContextBuildViewState): number {
  const all = [...state.primarySources, ...state.contextSources];
  return Math.max(12, ...all.map((t) => t.target.connectionId.length)) + 2;
}

function renderTargetLine(target: ContextBuildTargetState, frame: number, styled: boolean, width: number): string {
  return `    ${statusIcon(target.status, frame, styled)} ${target.target.connectionId.padEnd(width)} ${targetDetail(target, styled)}`;
}

function renderTargetGroup(
  label: string,
  targets: ContextBuildTargetState[],
  frame: number,
  styled: boolean,
  width: number,
): string[] {
  if (targets.length === 0) return [];
  return ['', `  ${label}:`, ...targets.map((t) => renderTargetLine(t, frame, styled, width))];
}

function resumeCommand(projectDir?: string): string {
  return projectDir ? `ktx setup --project-dir ${projectDir}` : 'ktx setup';
}

export function renderContextBuildView(
  state: ContextBuildViewState,
  options: { styled?: boolean; showHint?: boolean; projectDir?: string } = {},
): string {
  const styled = options.styled ?? true;
  const width = columnWidth(state);
  const lines: string[] = [
    '',
    'Building KTX context',
    '─────────────────────',
    ...renderTargetGroup('Primary sources', state.primarySources, state.frame, styled, width),
    ...renderTargetGroup('Context sources', state.contextSources, state.frame, styled, width),
    '',
  ];
  const hasActive = [...state.primarySources, ...state.contextSources].some(
    (t) => t.status === 'running' || t.status === 'queued',
  );
  if (options.showHint && hasActive) {
    const hint = `  d to detach · ${resumeCommand(options.projectDir)} to resume`;
    lines.push(styled ? dim(hint) : hint);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

// --- IO Capture ---

const ESC_K_RE = new RegExp(`${ESC.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\[K`, 'g');

export function extractProgressMessage(chunk: string): string | null {
  const cleaned = chunk.replace(/^\r/, '').replace(ESC_K_RE, '').replace(/\n$/, '').trim();
  const match = cleaned.match(/^\[(\d+)%\]\s*(.+)$/);
  return match ? `[${match[1]}%] ${match[2]}` : null;
}

export function parseScanSummary(output: string): string | null {
  const match = output.match(/(\d+) changes? across (\d+) tables?/);
  return match ? `${match[2]} tables` : null;
}

export function parseIngestSummary(output: string): string | null {
  const parts: string[] = [];
  const workUnits = output.match(/Work units: (\d+)/);
  if (workUnits) parts.push(`${workUnits[1]} work units`);
  const savedMemory = output.match(/Saved memory: (.+)/);
  if (savedMemory) parts.push(savedMemory[1]);
  return parts.length > 0 ? parts.join(' · ') : null;
}

interface CapturedIo {
  io: KtxCliIo;
  captured(): string;
}

function createCaptureIo(onProgress: (message: string) => void, isTTY: boolean): CapturedIo {
  let buffer = '';
  return {
    io: {
      stdout: {
        isTTY,
        write(chunk: string) {
          buffer += chunk;
          const progress = extractProgressMessage(chunk);
          if (progress) onProgress(progress);
        },
      },
      stderr: {
        write(chunk: string) {
          buffer += chunk;
        },
      },
    },
    captured: () => buffer,
  };
}

// --- Repaint ---

function createRepainter(io: KtxCliIo) {
  let lastLineCount = 0;

  return {
    paint(content: string) {
      if (lastLineCount > 0) {
        io.stdout.write(`${ESC}[${lastLineCount}A\r`);
      }
      io.stdout.write(content);
      io.stdout.write(`${ESC}[J`);
      lastLineCount = (content.match(/\n/g) ?? []).length;
    },
  };
}

// --- Background build ---

function resolveKtxEntryScript(): string | null {
  const argv1 = process.argv[1];
  if (argv1 && (argv1.endsWith('.js') || argv1.endsWith('.ts') || argv1.endsWith('.mjs'))) {
    return argv1;
  }
  return null;
}

function spawnBackgroundBuild(projectDir: string): { logPath: string } | null {
  const entryScript = resolveKtxEntryScript();
  if (!entryScript) return null;

  const resolvedDir = resolve(projectDir);
  const logDir = join(resolvedDir, '.ktx', 'setup');
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, 'context-build.log');
  const logFd = openSync(logPath, 'w');

  const child = spawn(
    process.execPath,
    [entryScript, 'setup', 'context', 'build', '--project-dir', resolvedDir, '--no-input'],
    { detached: true, stdio: ['ignore', logFd, logFd] },
  );
  child.unref();
  return { logPath };
}

// --- Keystroke handling ---

function defaultSetupKeystroke(onDetach: () => void, onCtrlC: () => void): (() => void) | null {
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    return null;
  }
  stdin.setRawMode(true);
  stdin.resume();
  const onData = (data: Buffer) => {
    const char = data.toString();
    if (char === 'd' || char === 'D') onDetach();
    else if (char === '\x03') onCtrlC();
  };
  stdin.on('data', onData);
  return () => {
    stdin.off('data', onData);
    if (typeof stdin.setRawMode === 'function') stdin.setRawMode(false);
    stdin.pause();
  };
}

// --- Orchestration ---

function makeTargetState(target: KtxPublicIngestPlanTarget): ContextBuildTargetState {
  return { target, status: 'queued', detailLine: null, summaryText: null, startedAt: null, elapsedMs: 0 };
}

export function initViewState(targets: KtxPublicIngestPlanTarget[]): ContextBuildViewState {
  return {
    primarySources: targets.filter((t) => t.operation === 'scan').map(makeTargetState),
    contextSources: targets.filter((t) => t.operation === 'source-ingest').map(makeTargetState),
    frame: 0,
  };
}

export async function runContextBuild(
  project: KtxPublicIngestProject,
  args: ContextBuildArgs,
  io: KtxCliIo,
  deps: ContextBuildDeps = {},
): Promise<ContextBuildResult> {
  const plan = buildPublicIngestPlan(project, { projectDir: args.projectDir, all: true });
  const state = initViewState(plan.targets);
  const isTTY = io.stdout.isTTY === true;
  const nowFn = deps.now ?? (() => Date.now());

  const repainter = isTTY ? createRepainter(io) : null;
  const viewOpts = { styled: true, projectDir: args.projectDir };
  const paint = (hint: boolean) => repainter?.paint(renderContextBuildView(state, { ...viewOpts, showHint: hint }));
  paint(true);

  let spinnerInterval: ReturnType<typeof setInterval> | null = null;
  if (repainter) {
    spinnerInterval = setInterval(() => {
      state.frame++;
      for (const t of [...state.primarySources, ...state.contextSources]) {
        if (t.status === 'running' && t.startedAt !== null) {
          t.elapsedMs = nowFn() - t.startedAt;
        }
      }
      paint(true);
    }, 140);
  }

  const orderedTargets = [...state.primarySources, ...state.contextSources];
  const execTarget = deps.executeTarget ?? executePublicIngestTarget;

  let detached = false;
  let cleanupKeystroke: (() => void) | null = null;

  if (isTTY || deps.setupKeystroke) {
    const cleanup = () => {
      if (spinnerInterval) clearInterval(spinnerInterval);
      cleanupKeystroke?.();
    };
    cleanupKeystroke = (deps.setupKeystroke ?? defaultSetupKeystroke)(
      () => {
        cleanup();
        deps.onDetach?.();
        const bg = spawnBackgroundBuild(args.projectDir);
        io.stdout.write('\n\nContext build continuing in the background.\n');
        if (bg) io.stdout.write(`Log: ${bg.logPath}\n`);
        io.stdout.write(`Status: ktx setup context status --project-dir ${resolve(args.projectDir)}\n`);
        io.stdout.write(`Resume: ${resumeCommand(args.projectDir)}\n`);
        process.exit(0);
      },
      () => {
        cleanup();
        io.stdout.write('\n\nContext build stopped. Nothing is running in the background.\n');
        io.stdout.write(`Resume: ${resumeCommand(args.projectDir)}\n`);
        process.exit(130);
      },
    );
  }
  const runArgs: Extract<KtxPublicIngestArgs, { command: 'run' }> = {
    command: 'run',
    projectDir: args.projectDir,
    all: true,
    json: false,
    inputMode: args.inputMode,
    scanMode: args.scanMode,
    detectRelationships: args.detectRelationships,
  };

  let hasFailure = false;

  try {
    for (const targetState of orderedTargets) {
      if (detached) break;

      targetState.status = 'running';
      targetState.startedAt = nowFn();
      paint(true);

      const capture = createCaptureIo(
        (message) => {
          targetState.detailLine = message;
          paint(true);
        },
        false,
      );

      const result = await execTarget(targetState.target, runArgs, capture.io, {});

      targetState.elapsedMs = nowFn() - (targetState.startedAt ?? nowFn());
      const failed = result.steps.some((s) => s.status === 'failed');
      targetState.status = failed ? 'failed' : 'done';
      targetState.detailLine = null;
      if (!failed) {
        targetState.summaryText =
          targetState.target.operation === 'scan'
            ? parseScanSummary(capture.captured())
            : parseIngestSummary(capture.captured());
      }
      if (failed) hasFailure = true;

      paint(true);
    }
  } finally {
    if (spinnerInterval) clearInterval(spinnerInterval);
    cleanupKeystroke?.();
  }

  if (detached) {
    return { exitCode: 0, detached: true };
  }

  if (!repainter) {
    io.stdout.write(renderContextBuildView(state, { styled: false }));
  } else {
    paint(false);
  }

  return { exitCode: hasFailure ? 1 : 0, detached: false };
}
