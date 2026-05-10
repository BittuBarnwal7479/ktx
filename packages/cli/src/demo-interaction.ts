import { cancel, confirm, isCancel, password, select, text } from '@clack/prompts';
import type { Option as ClackOption } from '@clack/prompts';
import { resolve } from 'node:path';
import { inspectDemoProjectState } from './demo-assets.js';
import type { KtxDemoInputMode } from './demo.js';
import { withMenuOptionsSpacing } from './prompt-navigation.js';

type DemoPromptOption<T extends string> = ClackOption<T>;

export interface DemoPromptAdapter {
  select<T extends string>(options: { message: string; options: Array<DemoPromptOption<T>> }): Promise<T>;
  confirm(options: { message: string; initialValue?: boolean }): Promise<boolean>;
  password(options: { message: string }): Promise<string>;
  text(options: { message: string; placeholder?: string }): Promise<string>;
  cancel(message: string): void;
}

interface DemoInteractiveIo {
  stdin?: { isTTY?: boolean };
  stdout: { isTTY?: boolean };
}

type DemoProjectDecision =
  | { action: 'use'; projectDir: string; reset: boolean }
  | { action: 'cancel' };

type FullCredentialDecision =
  | { action: 'full'; env: NodeJS.ProcessEnv }
  | { action: 'run-mode'; mode: 'seeded' | 'replay' }
  | { action: 'cancel' };

function isInteractive(inputMode: KtxDemoInputMode | undefined, io: DemoInteractiveIo): boolean {
  return inputMode !== 'disabled' && io.stdin?.isTTY === true && io.stdout.isTTY === true;
}

function cloneEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env };
}

function ensureNotCancelled<T>(value: T | symbol, prompts: Pick<DemoPromptAdapter, 'cancel'>): T {
  if (isCancel(value)) {
    prompts.cancel('Demo cancelled.');
    throw new Error('Demo cancelled.');
  }
  return value as T;
}

export function createClackDemoPromptAdapter(): DemoPromptAdapter {
  return {
    async select<T extends string>(options: { message: string; options: Array<DemoPromptOption<T>> }): Promise<T> {
      return ensureNotCancelled(await select(withMenuOptionsSpacing(options)), this);
    },
    async confirm(options: { message: string; initialValue?: boolean }): Promise<boolean> {
      return ensureNotCancelled(await confirm(options), this);
    },
    async password(options: { message: string }): Promise<string> {
      return ensureNotCancelled(await password(options), this);
    },
    async text(options: { message: string; placeholder?: string }): Promise<string> {
      return ensureNotCancelled(await text(options), this);
    },
    cancel(message: string): void {
      cancel(message);
    },
  };
}

export function createTestDemoPromptAdapter(options: {
  choices?: string[];
  confirms?: boolean[];
  passwords?: string[];
  texts?: string[];
}): DemoPromptAdapter {
  const choices = [...(options.choices ?? [])];
  const confirms = [...(options.confirms ?? [])];
  const passwords = [...(options.passwords ?? [])];
  const texts = [...(options.texts ?? [])];

  return {
    async select<T extends string>(): Promise<T> {
      return choices.shift() as T;
    },
    async confirm(): Promise<boolean> {
      return confirms.shift() ?? false;
    },
    async password(): Promise<string> {
      return passwords.shift() ?? '';
    },
    async text(): Promise<string> {
      return texts.shift() ?? '';
    },
    cancel(): void {
      return;
    },
  };
}

export async function chooseDemoProjectForInteractiveRun(options: {
  projectDir: string;
  inputMode?: KtxDemoInputMode;
  io: DemoInteractiveIo;
  prompts?: DemoPromptAdapter;
}): Promise<DemoProjectDecision> {
  const prompts = options.prompts ?? createClackDemoPromptAdapter();
  const projectDir = resolve(options.projectDir);
  const state = await inspectDemoProjectState(projectDir);

  if (!isInteractive(options.inputMode, options.io)) {
    if (state.status === 'corrupt') {
      throw new Error(
        `Demo project is not ready at ${projectDir}: missing ${state.missing.join(', ')}. Run ktx setup demo reset --project-dir ${projectDir} --force --no-input`,
      );
    }
    return { action: 'use', projectDir, reset: false };
  }

  if (state.status === 'missing') {
    return { action: 'use', projectDir, reset: false };
  }

  const choices =
    state.status === 'ready'
      ? [
          { value: 'reuse', label: 'Reuse existing demo project' },
          { value: 'reset', label: 'Reset demo project' },
          { value: 'other', label: 'Choose another directory' },
          { value: 'cancel', label: 'Cancel' },
        ]
      : [
          { value: 'reset', label: 'Reset corrupted demo project', hint: `Missing ${state.missing.join(', ')}` },
          { value: 'other', label: 'Choose another directory' },
          { value: 'cancel', label: 'Cancel' },
        ];

  const choice = await prompts.select({
    message: state.status === 'ready' ? `Demo project exists at ${projectDir}` : `Demo project is not ready at ${projectDir}`,
    options: choices,
  });

  if (choice === 'cancel') {
    prompts.cancel('Demo cancelled.');
    return { action: 'cancel' };
  }

  if (choice === 'other') {
    const nextProjectDir = await prompts.text({
      message: 'Demo project directory',
      placeholder: projectDir,
    });
    return { action: 'use', projectDir: resolve(nextProjectDir), reset: false };
  }

  if (choice === 'reset') {
    const confirmed = await prompts.confirm({
      message: `Recreate ${projectDir}? Existing demo artifacts under that directory will be removed.`,
      initialValue: false,
    });
    return confirmed ? { action: 'use', projectDir, reset: true } : { action: 'cancel' };
  }

  return { action: 'use', projectDir, reset: false };
}

export async function resolveFullCredentialDecision(options: {
  needsAnthropicKey: boolean;
  inputMode?: KtxDemoInputMode;
  io: DemoInteractiveIo;
  env: NodeJS.ProcessEnv;
  prompts?: DemoPromptAdapter;
}): Promise<FullCredentialDecision> {
  const env = cloneEnv(options.env);
  if (!options.needsAnthropicKey || env.ANTHROPIC_API_KEY) {
    return { action: 'full', env };
  }

  if (!isInteractive(options.inputMode, options.io)) {
    return { action: 'full', env };
  }

  const prompts = options.prompts ?? createClackDemoPromptAdapter();
  const choice = await prompts.select({
    message: 'Anthropic credentials are missing for the full demo',
    options: [
      { value: 'process_key', label: 'Enter key for this process only' },
      { value: 'seeded', label: 'Run pre-seeded demo without LLM' },
      { value: 'replay', label: 'Run packaged replay' },
      { value: 'cancel', label: 'Cancel' },
    ],
  });

  if (choice === 'cancel') {
    prompts.cancel('Demo cancelled.');
    return { action: 'cancel' };
  }

  if (choice === 'seeded' || choice === 'replay') {
    return { action: 'run-mode', mode: choice };
  }

  const key = await prompts.password({ message: 'ANTHROPIC_API_KEY' });
  return { action: 'full', env: { ...env, ANTHROPIC_API_KEY: key } };
}
