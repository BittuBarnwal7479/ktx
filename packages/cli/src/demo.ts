import {
  buildMemoryFlowViewModel,
  formatMemoryFlowFinalSummary,
  renderMemoryFlowReplay,
  type MemoryFlowReplayInput,
} from '@ktx/context/ingest/memory-flow';
import { resolveKtxConfigReference } from '@ktx/context/core';
import { loadKtxProject } from '@ktx/context/project';
import {
  DEMO_ADAPTER,
  DEMO_CONNECTION_ID,
  DEMO_FULL_JOB_ID,
  ensureDemoProject,
  loadProjectDemoReplay,
  resetDemoProject,
} from './demo-assets.js';
import { writeDemoReplay } from './demo-replay-store.js';
import {
  formatDemoInspect,
  formatDemoScanSummary,
  inspectDemoProject,
  runDemoScan,
} from './demo-scan.js';
import {
  formatSeededInspect,
  inspectSeededProject,
  runDemoSeeded,
} from './demo-seeded.js';
import { buildFullDemoReplay, formatCleanDemoSummary, formatFullDemoSummary, fullDemoCredentialStatus, runDemoFull } from './demo-full.js';
import { createPlainProgressEmitter } from './demo-progress.js';
import {
  chooseDemoProjectForInteractiveRun,
  createClackDemoPromptAdapter,
  resolveFullCredentialDecision,
  type DemoPromptAdapter,
} from './demo-interaction.js';
import type { KtxDoctorArgs } from './doctor.js';
import {
  renderMemoryFlowTui,
  startLiveMemoryFlowTui,
  type KtxMemoryFlowTuiIo,
  type MemoryFlowTuiLiveSession,
} from './memory-flow-tui.js';
import {
  rendererUnavailableVizFallback,
  resolveVizFallback,
  warnVizFallbackOnce,
} from './viz-fallback.js';
import { profileMark } from './startup-profile.js';
import { formatNextStepLines } from './next-steps.js';

profileMark('module:demo');

export type KtxDemoOutputMode = 'plain' | 'json' | 'viz';
export type KtxDemoInputMode = 'auto' | 'disabled';
export type KtxDemoMode = 'full' | 'seeded';

export type KtxDemoArgs =
  | { command: 'init'; projectDir: string; force: boolean; inputMode?: KtxDemoInputMode }
  | { command: 'reset'; projectDir: string; force: boolean; inputMode?: KtxDemoInputMode }
  | { command: 'replay'; projectDir: string; outputMode: KtxDemoOutputMode; inputMode?: KtxDemoInputMode }
  | { command: 'scan'; projectDir: string; inputMode?: KtxDemoInputMode }
  | { command: 'inspect'; projectDir: string; outputMode: KtxDemoOutputMode; inputMode?: KtxDemoInputMode }
  | { command: 'doctor'; projectDir: string; outputMode: Exclude<KtxDemoOutputMode, 'viz'>; inputMode?: KtxDemoInputMode }
  | { command: 'seeded'; projectDir: string; outputMode: KtxDemoOutputMode; inputMode?: KtxDemoInputMode }
  | { command: 'full'; projectDir: string; outputMode: KtxDemoOutputMode; inputMode?: KtxDemoInputMode }
  | {
      command: 'ingest';
      mode: KtxDemoMode;
      projectDir: string;
      outputMode: KtxDemoOutputMode;
      inputMode?: KtxDemoInputMode;
    };

export interface KtxDemoIo {
  stdin?: KtxMemoryFlowTuiIo['stdin'];
  stdout: { isTTY?: boolean; columns?: number; write(chunk: string): void };
  stderr: { write(chunk: string): void };
}

interface KtxDemoDeps {
  runFullDemo?: typeof runDemoFull;
  runDoctor?: (args: KtxDoctorArgs, io: KtxDemoIo) => Promise<number>;
  renderStoredMemoryFlow?: typeof renderMemoryFlowTui;
  startLiveMemoryFlow?: typeof startLiveMemoryFlowTui;
  env?: NodeJS.ProcessEnv;
  prompts?: DemoPromptAdapter;
}

const ADAPTER_PREFIXES = ['live_database_', 'metabase_', 'looker_', 'lookml_', 'metricflow_', 'notion_', 'historic_sql_', 'dbt_descriptions_'];
const DEMO_TUI_SPEED_MULTIPLIER = 0.125;

function humanizeUnitKeyPlain(unitKey: string): string {
  let key = unitKey.replace(/-/g, '_');
  for (const prefix of ADAPTER_PREFIXES) {
    if (key.startsWith(prefix)) { key = key.slice(prefix.length); break; }
  }
  return key.replace(/_/g, ' ');
}

function formatReplaySummary(input: MemoryFlowReplayInput): string {
  let slCount = 0;
  let wikiCount = 0;
  let chunkCount = 0;
  const unitResults: Array<{ unitKey: string; artifacts: Array<{ icon: string; text: string; hasSummary: boolean }> }> = [];
  let currentUnit: { unitKey: string; artifacts: Array<{ icon: string; text: string; hasSummary: boolean }> } | null = null;
  let conflictCount = 0;

  for (const e of input.events) {
    if (e.type === 'chunks_planned') {
      chunkCount = e.chunkCount;
    } else if (e.type === 'work_unit_started') {
      currentUnit = { unitKey: e.unitKey, artifacts: [] };
    } else if (e.type === 'candidate_action') {
      if (e.target === 'sl') slCount++;
      else wikiCount++;
      const detail = input.details.actions.find((a) => a.key === e.key && a.unitKey === e.unitKey);
      const icon = e.target === 'sl' ? '📊' : '📝';
      const name = e.key.split('.').pop()?.replace(/[_-]/g, ' ') ?? e.key;
      const text = detail?.summary ?? name;
      currentUnit?.artifacts.push({ icon, text, hasSummary: !!detail?.summary });
    } else if (e.type === 'work_unit_finished' && currentUnit) {
      unitResults.push(currentUnit);
      currentUnit = null;
    } else if (e.type === 'reconciliation_finished') {
      conflictCount = e.conflictCount;
    }
  }

  const lines: string[] = ['', '★ KTX finished ingesting your data', ''];

  if (chunkCount > 0) {
    lines.push(`  ✓ Analyzed ${chunkCount} business area${chunkCount === 1 ? '' : 's'}`);
  }

  lines.push(`  ✓ Reconciled — ${conflictCount > 0 ? `${conflictCount} conflict${conflictCount === 1 ? '' : 's'} resolved` : 'no conflicts'}`);
  lines.push('');

  if (slCount > 0 || wikiCount > 0) {
    lines.push('  KTX created:');
    if (slCount > 0) lines.push(`    📊 ${slCount} query definition${slCount === 1 ? '' : 's'} — so agents can write accurate SQL for your data`);
    if (wikiCount > 0) lines.push(`    📝 ${wikiCount} knowledge page${wikiCount === 1 ? '' : 's'} — so agents understand your business context`);
    lines.push('');
  }

  const described = unitResults.flatMap((u) => u.artifacts).filter((a) => a.hasSummary);
  for (const a of described) {
    lines.push(`    ${a.icon} ${a.text}`);
  }

  lines.push('');
  lines.push('  What to do next:');
  lines.push(...formatNextStepLines());
  if (input.sourceDir) {
    lines.push('');
    lines.push(`  Your KTX project files are at: ${input.sourceDir}`);
  }
  lines.push('');

  return lines.join('\n');
}

function formatPlainReplaySummary(input: MemoryFlowReplayInput): string {
  return [formatMemoryFlowFinalSummary(input).trimEnd(), '', 'What to do next:', ...formatNextStepLines(), ''].join('\n');
}

function writeReplay(input: MemoryFlowReplayInput, outputMode: KtxDemoOutputMode, io: KtxDemoIo): void {
  if (outputMode === 'json') {
    io.stdout.write(`${JSON.stringify(input, null, 2)}\n`);
    return;
  }

  if (outputMode === 'plain') {
    io.stdout.write(formatPlainReplaySummary(input));
    return;
  }

  const view = buildMemoryFlowViewModel(input);
  io.stdout.write(renderMemoryFlowReplay(view, { terminalWidth: io.stdout.columns ?? process.stdout.columns }));
}

async function writeStoredReplay(
  input: MemoryFlowReplayInput,
  outputMode: KtxDemoOutputMode,
  inputMode: KtxDemoArgs['inputMode'],
  io: KtxDemoIo,
  deps: KtxDemoDeps,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const resolvedOutputMode = effectiveDemoOutputMode(outputMode, io, env, {
    requireInput: inputMode !== 'disabled',
  });
  if (resolvedOutputMode !== 'viz') {
    writeReplay(input, resolvedOutputMode, io);
    return;
  }

  if (inputMode !== 'disabled') {
    const renderStoredMemoryFlow = deps.renderStoredMemoryFlow ?? renderMemoryFlowTui;
    if (
      isTuiCapableDemoIo(io) &&
      (await renderStoredMemoryFlow(input, io, { speedMultiplier: DEMO_TUI_SPEED_MULTIPLIER }))
    ) {
      io.stdout.write(formatReplaySummary(input));
      return;
    }
  }

  writeReplay(input, resolvedOutputMode, io);
}

function writeInspect(
  summary: Awaited<ReturnType<typeof inspectDemoProject>>,
  outputMode: KtxDemoOutputMode,
  io: KtxDemoIo,
): void {
  if (outputMode === 'json') {
    io.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }

  io.stdout.write(formatDemoInspect(summary));
}

function writeFullDemo(
  result: Awaited<ReturnType<typeof runDemoFull>>,
  outputMode: KtxDemoOutputMode,
  io: KtxDemoIo,
  options: { liveWasRendered?: boolean; projectDir?: string } = {},
): void {
  if (outputMode === 'json') {
    io.stdout.write(`${JSON.stringify({ report: result.report, replay: result.replay }, null, 2)}\n`);
    return;
  }

  if (outputMode === 'viz' && options.liveWasRendered !== true) {
    writeReplay(buildFullDemoReplay(result.report), outputMode, io);
    io.stdout.write('\n');
  }

  if (outputMode === 'viz' && options.liveWasRendered) {
    io.stdout.write(formatCleanDemoSummary(result.report, options.projectDir ?? ''));
    return;
  }

  if (outputMode === 'viz') {
    io.stdout.write(formatMemoryFlowFinalSummary(buildFullDemoReplay(result.report)));
  }

  io.stdout.write(formatFullDemoSummary(result.report));
}

function replayWithFullMetadata(result: Awaited<ReturnType<typeof runDemoFull>>): MemoryFlowReplayInput {
  if (result.replay.metadata) {
    return result.replay;
  }

  return {
    ...result.replay,
    metadata: {
      schemaVersion: 1,
      mode: 'full',
      origin: 'captured',
      timing: 'captured',
      capturedAt: result.report.createdAt,
      sourceReportId: result.report.id,
      sourceReportPath: result.report.id,
      fallbackReason: null,
    },
    reportId: result.replay.reportId ?? result.report.id,
    reportPath: result.replay.reportPath ?? result.report.id,
  };
}

function pickMemoryFlowProgress(
  liveSession: MemoryFlowTuiLiveSession | null,
  outputMode: KtxDemoOutputMode,
  io: KtxDemoIo,
): ((snapshot: MemoryFlowReplayInput) => void) | undefined {
  if (liveSession) {
    return (snapshot: MemoryFlowReplayInput) => {
      if (!liveSession.isClosed()) {
        liveSession.update(snapshot);
      }
    };
  }
  if (outputMode === 'json') {
    return undefined;
  }
  return createPlainProgressEmitter(io);
}

function isTuiCapableDemoIo(io: KtxDemoIo): io is KtxDemoIo & KtxMemoryFlowTuiIo {
  return (
    io.stdin?.isTTY === true &&
    io.stdout.isTTY === true &&
    typeof io.stdin.setRawMode === 'function' &&
    typeof io.stdout.write === 'function'
  );
}

interface EffectiveDemoOutputModeOptions {
  requireInput?: boolean;
}

function effectiveDemoOutputMode(
  outputMode: KtxDemoOutputMode,
  io: KtxDemoIo,
  env: NodeJS.ProcessEnv,
  options: EffectiveDemoOutputModeOptions = {},
): KtxDemoOutputMode {
  if (outputMode !== 'viz') {
    return outputMode;
  }

  const fallback = resolveVizFallback(io, env, { requireInput: options.requireInput ?? false });
  if (!fallback.shouldDegrade) {
    return outputMode;
  }

  warnVizFallbackOnce(io, fallback);
  return 'plain';
}

function initialFullDemoMemoryFlowInput(projectDir: string): MemoryFlowReplayInput {
  return {
    runId: DEMO_FULL_JOB_ID,
    connectionId: DEMO_CONNECTION_ID,
    adapter: DEMO_ADAPTER,
    status: 'running',
    sourceDir: `${projectDir}/raw-sources/${DEMO_CONNECTION_ID}/${DEMO_ADAPTER}`,
    syncId: 'pending',
    errors: [],
    events: [],
    plannedWorkUnits: [],
    details: { actions: [], provenance: [], transcripts: [] },
  };
}

async function ensureDemoProjectForCommand(projectDir: string): Promise<void> {
  await ensureDemoProject({ projectDir, force: false }).catch((error) => {
    if (error instanceof Error && error.message.includes('Demo project already exists')) {
      return null;
    }
    throw error;
  });
}

async function prepareProjectForDemoCommand(args: KtxDemoArgs, io: KtxDemoIo, deps: KtxDemoDeps): Promise<string | null> {
  if (args.command === 'init' || args.command === 'reset' || args.command === 'doctor') {
    return args.projectDir;
  }

  const prompts = deps.prompts ?? createClackDemoPromptAdapter();
  const decision = await chooseDemoProjectForInteractiveRun({
    projectDir: args.projectDir,
    inputMode: args.inputMode,
    io,
    prompts,
  });

  if (decision.action === 'cancel') {
    return null;
  }

  if (decision.reset) {
    await resetDemoProject({ projectDir: decision.projectDir, force: true });
  }

  return decision.projectDir;
}

async function runReplayDemo(
  projectDir: string,
  outputMode: KtxDemoOutputMode,
  inputMode: KtxDemoArgs['inputMode'],
  io: KtxDemoIo,
  deps: KtxDemoDeps,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  await ensureDemoProjectForCommand(projectDir);
  await writeStoredReplay(await loadProjectDemoReplay(projectDir), outputMode, inputMode, io, deps, env);
  return 0;
}

async function runSeededDemo(
  projectDir: string,
  outputMode: KtxDemoOutputMode,
  inputMode: KtxDemoArgs['inputMode'],
  io: KtxDemoIo,
  deps: KtxDemoDeps,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const result = await runDemoSeeded({ projectDir });
  const resolvedOutputMode = effectiveDemoOutputMode(outputMode, io, env, {
    requireInput: inputMode !== 'disabled',
  });

  if (resolvedOutputMode === 'json') {
    io.stdout.write(`${JSON.stringify({ replay: result.replay, inspect: result.inspect }, null, 2)}\n`);
    return 0;
  }

  if (resolvedOutputMode === 'viz') {
    await writeStoredReplay(result.replay, resolvedOutputMode, inputMode, io, deps, env);
  } else {
    writeReplay(result.replay, resolvedOutputMode, io);
    io.stdout.write('\n');
    io.stdout.write(formatSeededInspect(result.inspect));
  }
  return 0;
}

export async function runKtxDemo(args: KtxDemoArgs, io: KtxDemoIo = process, deps: KtxDemoDeps = {}): Promise<number> {
  try {
    if (args.command === 'init') {
      const result = await ensureDemoProject({ projectDir: args.projectDir, force: args.force });
      io.stdout.write(`Demo project: ${result.projectDir}\n`);
      io.stdout.write(`Config: ${result.configPath}\n`);
      io.stdout.write(`Database: ${result.databasePath}\n`);
      io.stdout.write(`Replay: ${result.replayPath}\n`);
      io.stdout.write('Next: ktx setup demo --no-input\n');
      io.stdout.write('  Runs the pre-seeded demo without calling the LLM.\n');
      return 0;
    }

    if (args.command === 'reset') {
      const result = await resetDemoProject({ projectDir: args.projectDir, force: args.force });
      io.stdout.write(`Demo project reset: ${result.projectDir}\n`);
      io.stdout.write(`Config: ${result.configPath}\n`);
      io.stdout.write(`Database: ${result.databasePath}\n`);
      io.stdout.write(`Replay: ${result.replayPath}\n`);
      io.stdout.write('Next: ktx setup demo --mode full\n');
      io.stdout.write('  Runs the full AI-backed pass with your LLM provider.\n');
      return 0;
    }

    const preparedProjectDir = await prepareProjectForDemoCommand(args, io, deps);
    if (preparedProjectDir === null) {
      return 1;
    }
    const env = deps.env ?? process.env;

    if (args.command === 'scan') {
      const { result } = await runDemoScan({ projectDir: preparedProjectDir });
      io.stdout.write(formatDemoScanSummary(result.report));
      return 0;
    }

    if (args.command === 'seeded' || (args.command === 'ingest' && args.mode === 'seeded')) {
      return await runSeededDemo(preparedProjectDir, args.outputMode, args.inputMode, io, deps, env);
    }

    if (args.command === 'full' || (args.command === 'ingest' && args.mode === 'full')) {
      const executeFullDemo = deps.runFullDemo ?? runDemoFull;
      await ensureDemoProjectForCommand(preparedProjectDir);
      const project = await loadKtxProject({ projectDir: preparedProjectDir });
      const credentialStatus = fullDemoCredentialStatus(project, env);
      const credentialDecision = await resolveFullCredentialDecision({
        needsAnthropicKey:
          credentialStatus.status === 'missing-anthropic-key' &&
          project.config.llm.provider.backend === 'anthropic' &&
          !resolveKtxConfigReference(project.config.llm.provider.anthropic?.api_key, env),
        inputMode: args.inputMode,
        io,
        env,
        prompts: deps.prompts ?? createClackDemoPromptAdapter(),
      });

      if (credentialDecision.action === 'cancel') {
        return 1;
      }

      if (credentialDecision.action === 'run-mode') {
        return credentialDecision.mode === 'seeded'
          ? await runSeededDemo(preparedProjectDir, args.outputMode, args.inputMode, io, deps, env)
          : await runReplayDemo(preparedProjectDir, args.outputMode, args.inputMode, io, deps, env);
      }

      let liveSession: MemoryFlowTuiLiveSession | null = null;
      let liveWasRendered = false;
      const startLiveMemoryFlow = deps.startLiveMemoryFlow ?? startLiveMemoryFlowTui;
      let fullOutputMode = effectiveDemoOutputMode(args.outputMode, io, env, {
        requireInput: args.inputMode !== 'disabled',
      });
      const shouldUseLiveViz = fullOutputMode === 'viz' && args.inputMode !== 'disabled';

      if (shouldUseLiveViz && isTuiCapableDemoIo(io)) {
        liveSession = await startLiveMemoryFlow(initialFullDemoMemoryFlowInput(preparedProjectDir), io);
        liveWasRendered = liveSession !== null;
      } else if (shouldUseLiveViz) {
        warnVizFallbackOnce(io, rendererUnavailableVizFallback());
        fullOutputMode = 'plain';
      }

      const onMemoryFlowChange = pickMemoryFlowProgress(liveSession, fullOutputMode, io);
      const result = await executeFullDemo({
        projectDir: preparedProjectDir,
        env: credentialDecision.env,
        ...(onMemoryFlowChange ? { onMemoryFlowChange } : {}),
      });
      await writeDemoReplay(preparedProjectDir, replayWithFullMetadata(result), { label: 'full' });
      liveSession?.close();
      writeFullDemo(result, fullOutputMode, io, { liveWasRendered, projectDir: preparedProjectDir });
      if (fullOutputMode !== 'json' && !liveWasRendered) {
        io.stdout.write(formatDemoInspect(await inspectDemoProject(preparedProjectDir)));
      }
      return 0;
    }

    if (args.command === 'inspect') {
      const seededInspect = await inspectSeededProject(preparedProjectDir).catch(() => null);
      if (seededInspect?.mode === 'seeded') {
        if (args.outputMode === 'json') {
          io.stdout.write(`${JSON.stringify(seededInspect, null, 2)}\n`);
        } else {
          io.stdout.write(formatSeededInspect(seededInspect));
        }
        return 0;
      }
      writeInspect(await inspectDemoProject(preparedProjectDir), args.outputMode, io);
      return 0;
    }

    if (args.command === 'doctor') {
      const { runKtxDoctor } = await import('./doctor.js');
      const executeDoctor = deps.runDoctor ?? runKtxDoctor;
      return await executeDoctor(
        {
          command: 'demo',
          projectDir: args.projectDir,
          outputMode: args.outputMode,
          ...(args.inputMode ? { inputMode: args.inputMode } : {}),
        },
        io,
      );
    }

    return await runReplayDemo(preparedProjectDir, args.outputMode, args.inputMode, io, deps, env);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
