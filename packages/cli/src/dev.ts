import { resolve } from 'node:path';
import type { Command } from '@commander-js/extra-typings';
import { type CommandWithGlobalOptions, type KtxCliCommandContext, resolveCommandProjectDir } from './cli-program.js';
import { registerCompletionCommands } from './commands/completion-commands.js';
import { registerConnectionMappingCommands } from './commands/connection-commands.js';
import { registerDoctorCommands } from './commands/doctor-commands.js';
import { registerIngestCommands } from './commands/ingest-commands.js';
import { registerScanCommands } from './commands/scan-commands.js';
import { profileMark } from './startup-profile.js';

profileMark('module:dev');

export function registerDevCommands(program: Command, context: KtxCliCommandContext): void {
  const dev = program
    .command('dev', { hidden: true })
    .description('Low-level diagnostics, scans, adapter commands, and mapping tools')
    .showHelpAfterError();

  dev.hook('preAction', (_thisCommand, actionCommand) => {
    context.writeDebug?.('dev', actionCommand);
  });

  dev.action(() => {
    dev.outputHelp();
    context.setExitCode(0);
  });

  dev
    .command('init')
    .description('Initialize a Git-backed KTX project directory for maintenance scripts')
    .argument('[directory]', 'Project directory')
    .option('--name <name>', 'Project name written to ktx.yaml')
    .option('--force', 'Rewrite ktx.yaml and scaffold files in an existing project', false)
    .action(
      async (
        projectDir: string | undefined,
        commandOptions: { name?: string; force?: boolean },
        command: CommandWithGlobalOptions,
      ) => {
        context.setExitCode(
          await context.runInit(
            {
              projectDir: projectDir ? resolve(projectDir) : resolveCommandProjectDir(command),
              ...(commandOptions.name ? { projectName: commandOptions.name } : {}),
              force: commandOptions.force === true,
            },
            context.io,
          ),
        );
      },
    );

  registerDoctorCommands(dev, context);
  registerScanCommands(dev, context);
  registerIngestCommands(dev, context, {
    runIngestWithProgress: async (ingestArgs, ingestIo, ingestDeps, defaultRunIngest) =>
      await (ingestDeps.ingest ?? defaultRunIngest)(ingestArgs, ingestIo),
  });
  registerConnectionMappingCommands(dev, context);
  registerCompletionCommands(dev, context, program);
}
