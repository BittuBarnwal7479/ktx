import { type Command, Option } from '@commander-js/extra-typings';
import {
  type CommandWithGlobalOptions,
  type KtxCliCommandContext,
  resolveCommandProjectDirOverride,
} from '../cli-program.js';
import {
  type KtxDemoArgs,
  type KtxDemoInputMode,
  type KtxDemoMode,
  type KtxDemoOutputMode,
} from '../demo.js';
import { defaultDemoProjectDir } from '../demo-assets.js';
import { resolveProjectDir } from '../project-dir.js';
import { profileMark } from '../startup-profile.js';

profileMark('module:commands/demo-commands');

interface DemoOptions {
  plain?: boolean;
  json?: boolean;
  input?: boolean;
  projectDir?: string;
}

function demoOutputMode(options: { plain?: boolean; json?: boolean }): KtxDemoOutputMode {
  if (options.json === true) {
    return 'json';
  }
  if (options.plain === true) {
    return 'plain';
  }
  return 'viz';
}

function demoDoctorOutputMode(options: { json?: boolean }): 'plain' | 'json' {
  return options.json === true ? 'json' : 'plain';
}

function demoInspectOutputMode(options: { plain?: boolean; json?: boolean }): KtxDemoOutputMode {
  if (options.json === true) {
    return 'json';
  }
  return 'plain';
}

function demoInputMode(options: { input?: boolean }): { inputMode?: KtxDemoInputMode } {
  return options.input === false ? { inputMode: 'disabled' } : {};
}

function demoProjectDir(options: { projectDir?: string }, command: CommandWithGlobalOptions): string {
  return resolveProjectDir(
    options.projectDir ?? resolveCommandProjectDirOverride(command),
    defaultDemoProjectDir(),
  );
}

type CommandOptionSourceReader = {
  getOptionValueSource?: (name: string) => string | undefined;
  parent?: unknown;
};

function inheritedOptionSource(command: CommandOptionSourceReader, key: string): string | undefined {
  let current = command.parent as (CommandOptionSourceReader & { opts?: () => Record<string, unknown> }) | undefined;
  while (current) {
    const source = current.getOptionValueSource?.(key);
    if (source !== undefined) {
      return source;
    }
    current = current.parent as (CommandOptionSourceReader & { opts?: () => Record<string, unknown> }) | undefined;
  }
  return undefined;
}

function definedOptions(
  options: Record<string, unknown>,
  inherited: Record<string, unknown> = {},
  command?: CommandOptionSourceReader,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(options).filter(([key, value]) => {
      if (value === undefined) return false;
      if (key === 'input' && value === true && inherited.input === false) return false;
      if (
        key === 'mode' &&
        command?.getOptionValueSource?.(key) === 'default' &&
        inherited[key] !== undefined &&
        inherited[key] !== value &&
        inheritedOptionSource(command, key) === 'cli'
      ) {
        return false;
      }
      return true;
    }),
  );
}

export function resolveDemoCommandOptions<T>(command: { opts: () => T; optsWithGlobals?: () => T; parent?: unknown }): T {
  const chain: Array<{ opts?: () => Record<string, unknown>; parent?: unknown }> = [];
  let current = command.parent as { opts?: () => Record<string, unknown>; parent?: unknown } | undefined;
  while (current) {
    chain.unshift(current);
    current = current.parent as { opts?: () => Record<string, unknown>; parent?: unknown } | undefined;
  }
  const inherited = Object.assign({}, ...chain.map((parent) => definedOptions(parent.opts?.() ?? {})));

  if (command.optsWithGlobals) {
    const withGlobals = {
      ...inherited,
      ...definedOptions(command.optsWithGlobals() as Record<string, unknown>, inherited, command),
    };
    return {
      ...withGlobals,
      ...definedOptions(command.opts() as Record<string, unknown>, withGlobals, command),
    } as T;
  }

  return { ...inherited, ...definedOptions(command.opts() as Record<string, unknown>, inherited, command) } as T;
}

async function runDemoArgs(context: KtxCliCommandContext, args: KtxDemoArgs): Promise<void> {
  const runner = context.deps.demo ?? (await import('../demo.js')).runKtxDemo;
  context.setExitCode(await runner(args, context.io));
}

export function registerDemoCommands(
  program: Command,
  context: KtxCliCommandContext,
  options: { description?: string } = {},
): void {
  const demo = program
    .command('demo')
    .description(options.description ?? 'Run the pre-seeded KTX demo or a full LLM-backed demo')
    .addOption(
      new Option('--mode <mode>', 'Demo mode: seeded (default), replay, or full')
        .choices(['seeded', 'replay', 'full'])
        .default('seeded'),
    )
    .option('--project-dir <path>', 'Demo project directory')
    .addOption(new Option('--plain', 'Print plain text output instead of the visual demo').conflicts('json'))
    .addOption(new Option('--json', 'Print JSON output').conflicts('plain'))
    .option('--no-input', 'Disable interactive terminal input')
    .showHelpAfterError()
    .action(async (options: { mode: 'seeded' | 'replay' | 'full' } & DemoOptions, command) => {
      const resolvedOptions = resolveDemoCommandOptions<typeof options>(command);
      await runDemoArgs(context, {
        command: resolvedOptions.mode,
        projectDir: demoProjectDir(resolvedOptions, command),
        outputMode: demoOutputMode(resolvedOptions),
        ...demoInputMode(resolvedOptions),
      });
    });

  demo
    .command('init')
    .description('Initialize the packaged demo project')
    .option('--project-dir <path>', 'Demo project directory')
    .option('--force', 'Recreate an existing demo project', false)
    .option('--no-input', 'Disable interactive terminal input')
    .action(async (_options, command: { opts: () => { projectDir?: string; force?: boolean; input?: boolean } }) => {
      const options = resolveDemoCommandOptions(command);
      await runDemoArgs(context, {
        command: 'init',
        projectDir: demoProjectDir(options, command),
        force: options.force === true,
        ...demoInputMode(options),
      });
    });

  demo
    .command('reset')
    .description('Reset the packaged demo project')
    .option('--project-dir <path>', 'Demo project directory')
    .option('--force', 'Recreate the demo project without prompting', false)
    .option('--no-input', 'Disable interactive terminal input')
    .action(async (_options, command: { opts: () => { projectDir?: string; force?: boolean; input?: boolean } }) => {
      const options = resolveDemoCommandOptions(command);
      await runDemoArgs(context, {
        command: 'reset',
        projectDir: demoProjectDir(options, command),
        force: options.force === true,
        ...demoInputMode(options),
      });
    });

  demo
    .command('replay')
    .description('Replay the packaged demo memory-flow')
    .option('--project-dir <path>', 'Demo project directory')
    .addOption(new Option('--plain', 'Print plain text output instead of the visual demo').conflicts('json'))
    .addOption(new Option('--json', 'Print JSON output').conflicts('plain'))
    .option('--no-input', 'Disable interactive terminal input')
    .action(async (_options, command: { opts: () => DemoOptions }) => {
      const options = resolveDemoCommandOptions(command);
      await runDemoArgs(context, {
        command: 'replay',
        projectDir: demoProjectDir(options, command),
        outputMode: demoOutputMode(options),
        ...demoInputMode(options),
      });
    });

  demo
    .command('scan')
    .description('Run the packaged demo scan')
    .option('--project-dir <path>', 'Demo project directory')
    .option('--no-input', 'Disable interactive terminal input')
    .action(async (_options, command: { opts: () => { projectDir?: string; input?: boolean } }) => {
      const options = resolveDemoCommandOptions(command);
      await runDemoArgs(context, {
        command: 'scan',
        projectDir: demoProjectDir(options, command),
        ...demoInputMode(options),
      });
    });

  demo
    .command('inspect')
    .description('Inspect packaged demo outputs')
    .option('--project-dir <path>', 'Demo project directory')
    .addOption(new Option('--plain', 'Print plain text output').conflicts('json'))
    .addOption(new Option('--json', 'Print JSON output').conflicts('plain'))
    .option('--no-input', 'Disable interactive terminal input')
    .action(async (_options, command: { opts: () => DemoOptions }) => {
      const options = resolveDemoCommandOptions(command);
      await runDemoArgs(context, {
        command: 'inspect',
        projectDir: demoProjectDir(options, command),
        outputMode: demoInspectOutputMode(options),
        ...demoInputMode(options),
      });
    });

  demo
    .command('doctor')
    .description('Check packaged demo readiness')
    .option('--project-dir <path>', 'Demo project directory')
    .addOption(new Option('--plain', 'Print plain text output').conflicts('json'))
    .addOption(new Option('--json', 'Print JSON output').conflicts('plain'))
    .option('--no-input', 'Disable interactive terminal input')
    .action(async (_options, command: { opts: () => DemoOptions }) => {
      const options = resolveDemoCommandOptions(command);
      await runDemoArgs(context, {
        command: 'doctor',
        projectDir: demoProjectDir(options, command),
        outputMode: demoDoctorOutputMode(options),
        ...demoInputMode(options),
      });
    });

  demo
    .command('ingest')
    .description('Run packaged demo ingest')
    .addOption(
      new Option('--mode <mode>', 'Demo ingest mode: full or seeded')
        .choices(['full', 'seeded'])
        .default('full'),
    )
    .option('--project-dir <path>', 'Demo project directory')
    .addOption(new Option('--plain', 'Print plain text output instead of the visual demo').conflicts('json'))
    .addOption(new Option('--json', 'Print JSON output').conflicts('plain'))
    .option('--no-input', 'Disable interactive terminal input')
    .action(async (_options, command: { opts: () => { mode: KtxDemoMode } & DemoOptions }) => {
      const options = resolveDemoCommandOptions(command);
      await runDemoArgs(context, {
        command: 'ingest',
        mode: options.mode,
        projectDir: demoProjectDir(options, command),
        outputMode: demoOutputMode(options),
        ...demoInputMode(options),
      });
    });
}
