import { InvalidArgumentError, type Command } from '@commander-js/extra-typings';
import { type KtxCliCommandContext, resolveCommandProjectDir } from '../cli-program.js';
import { publicIngestReadCommandSchema, publicIngestRunCommandSchema } from '../command-schemas.js';
import type { KtxPublicIngestArgs, KtxPublicIngestInputMode } from '../public-ingest.js';
import { profileMark } from '../startup-profile.js';

profileMark('module:commands/public-ingest-commands');

interface PublicIngestOptions {
  all?: boolean;
  json?: boolean;
  input?: boolean;
}

function inputMode(options: { input?: boolean }): KtxPublicIngestInputMode {
  return options.input === false ? 'disabled' : 'auto';
}

async function runPublicIngestArgs(context: KtxCliCommandContext, args: KtxPublicIngestArgs): Promise<void> {
  const runner = context.deps.publicIngest ?? (await import('../public-ingest.js')).runKtxPublicIngest;
  context.setExitCode(await runner(args, context.io));
}

function parsePublicIngestConnectionId(value: string): string {
  if (value === 'run') {
    throw new InvalidArgumentError('run is reserved; use ktx dev ingest run for low-level adapter syntax');
  }
  return value;
}

export function registerPublicIngestCommands(program: Command, context: KtxCliCommandContext): void {
  const ingest = program
    .command('ingest')
    .description('Build and refresh KTX context from configured sources')
    .usage('[options] [connectionId]')
    .argument('[connectionId]', 'Connection id to ingest', parsePublicIngestConnectionId)
    .option('--all', 'Ingest every eligible configured source', false)
    .option('--json', 'Print JSON output', false)
    .option('--no-input', 'Disable interactive terminal input')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  ktx ingest <connectionId> [options]',
        '  ktx ingest --all [options]',
        '  ktx ingest status [runId] [options]',
        '  ktx ingest watch [runId] [options]',
        '',
        'Project directory defaults to KTX_PROJECT_DIR when set, otherwise the current working directory.',
        '',
      ].join('\n'),
    )
    .showHelpAfterError()
    .hook('preAction', (_thisCommand, actionCommand) => {
      context.writeDebug?.('ingest', actionCommand);
    })
    .action(async (connectionId: string | undefined, _options: PublicIngestOptions, command) => {
      const options = command.opts();
      if (options.all === true && connectionId) {
        throw new Error('ktx ingest accepts either --all or <connectionId>, not both');
      }
      const args = publicIngestRunCommandSchema.parse({
        command: 'run',
        projectDir: resolveCommandProjectDir(command),
        ...(connectionId ? { targetConnectionId: connectionId } : {}),
        all: options.all === true,
        json: options.json === true,
        inputMode: inputMode(options),
      });
      await runPublicIngestArgs(context, args);
    });

  ingest
    .command('status')
    .description('Print status for the latest or selected public ingest run')
    .argument('[runId]', 'Public ingest run id')
    .option('--json', 'Print JSON output', false)
    .option('--no-input', 'Disable interactive terminal input')
    .action(async (runId: string | undefined, _options: PublicIngestOptions, command) => {
      const options = (command.optsWithGlobals ? command.optsWithGlobals() : command.opts()) as PublicIngestOptions;
      const args = publicIngestReadCommandSchema.parse({
        command: 'status',
        projectDir: resolveCommandProjectDir(command),
        ...(runId ? { runId } : {}),
        json: options.json === true,
        inputMode: inputMode(options),
      });
      await runPublicIngestArgs(context, args);
    });

  ingest
    .command('watch')
    .description('Open the latest or selected public ingest visual report')
    .argument('[runId]', 'Public ingest run id')
    .option('--json', 'Print JSON output instead of the visual report', false)
    .option('--no-input', 'Disable interactive terminal input')
    .action(async (runId: string | undefined, _options: PublicIngestOptions, command) => {
      const options = (command.optsWithGlobals ? command.optsWithGlobals() : command.opts()) as PublicIngestOptions;
      const args = publicIngestReadCommandSchema.parse({
        command: 'watch',
        projectDir: resolveCommandProjectDir(command),
        ...(runId ? { runId } : {}),
        json: options.json === true,
        inputMode: inputMode(options),
      });
      await runPublicIngestArgs(context, args);
    });
}
