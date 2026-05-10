import type { CommandUnknownOpts } from '@commander-js/extra-typings';
import type { KtxCliCommandContext } from '../cli-program.js';
import { completeCommanderInput, installZshCompletion, zshCompletionScript } from '../completion.js';

export function registerCompletionCommands(
  program: CommandUnknownOpts,
  context: KtxCliCommandContext,
  completionRoot: CommandUnknownOpts = program,
): void {
  program
    .command('completion')
    .description('Generate shell completion scripts')
    .command('zsh')
    .description('Generate zsh completion script')
    .option('--install', 'Install zsh completion into ~/.zfunc and update ~/.zshrc', false)
    .action(async (options: { install?: boolean }) => {
      if (options.install === true) {
        const result = await installZshCompletion();
        context.io.stdout.write(`Installed zsh completion: ${result.completionPath}\n`);
        context.io.stdout.write(`Updated zsh config: ${result.zshrcPath}\n`);
        context.io.stdout.write('Restart your shell or run: source ~/.zshrc\n');
        context.setExitCode(0);
        return;
      }
      context.io.stdout.write(zshCompletionScript());
      context.setExitCode(0);
    });

  program
    .command('__complete', { hidden: true })
    .description('Internal shell completion endpoint')
    .requiredOption('--shell <shell>', 'Shell requesting completions')
    .requiredOption('--position <position>', 'Current shell word position', (value) => Number(value))
    .argument('[words...]', 'Current shell words')
    .allowUnknownOption()
    .allowExcessArguments()
    .action((words: string[], options: { shell: string; position: number }) => {
      if (options.shell !== 'zsh') {
        context.setExitCode(1);
        return;
      }
      for (const completion of completeCommanderInput(completionRoot, { position: options.position, words })) {
        context.io.stdout.write(`${completion}\n`);
      }
      context.setExitCode(0);
    });
}
