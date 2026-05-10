import { type Command, InvalidArgumentError } from '@commander-js/extra-typings';
import { collectOption, type KtxCliCommandContext, resolveCommandProjectDir } from '../cli-program.js';
import type { KtxConnectionNotionArgs } from './connection-notion.js';

interface NotionPickOptions {
  input?: boolean;
  rootPageId: string[];
}

function parseSafeConnectionId(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) {
    throw new InvalidArgumentError(`Unsafe connection id: ${value}`);
  }
  return value;
}

function uniqueInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

function normalizeNotionPageId(value: string): string {
  const trimmed = value.trim();
  const compact = trimmed.includes('-') ? trimmed.replace(/-/g, '') : trimmed;
  if (!/^[0-9a-fA-F]{32}$/.test(compact)) {
    throw new Error(`Invalid Notion page UUID: ${value}`);
  }
  const lower = compact.toLowerCase();
  return `${lower.slice(0, 8)}-${lower.slice(8, 12)}-${lower.slice(12, 16)}-${lower.slice(16, 20)}-${lower.slice(20)}`;
}

function buildPickArgs(connectionId: string, projectDir: string, options: NotionPickOptions): KtxConnectionNotionArgs {
  if (options.input !== false) {
    return {
      command: 'pick',
      projectDir,
      connectionId,
      mode: 'interactive',
    };
  }

  const rootPageIds = uniqueInOrder(options.rootPageId.map(normalizeNotionPageId));
  if (rootPageIds.length === 0) {
    throw new Error('connection notion pick --no-input requires at least one --root-page-id');
  }
  return {
    command: 'pick',
    projectDir,
    connectionId,
    mode: 'non-interactive',
    rootPageIds,
  };
}

async function runConnectionNotionArgs(context: KtxCliCommandContext, args: KtxConnectionNotionArgs): Promise<void> {
  const runner = context.deps.connectionNotion ?? (await import('./connection-notion.js')).runKtxConnectionNotion;
  context.setExitCode(await runner(args, context.io));
}

export function registerConnectionNotionCommands(connect: Command, context: KtxCliCommandContext): void {
  const notion = connect
    .command('notion')
    .description('Configure Notion source selection')
    .showHelpAfterError()
    .addHelpText(
      'after',
      '\nProject directory defaults to KTX_PROJECT_DIR when set, otherwise the current working directory.\n',
    );

  notion.action(() => {
    notion.outputHelp();
    context.setExitCode(0);
  });

  notion
    .command('pick')
    .description('Pick Notion root pages for a configured Notion connection')
    .argument('<connectionId>', 'Notion connection id', parseSafeConnectionId)
    .option('--no-input', 'Disable interactive terminal input')
    .option('--root-page-id <id>', 'Root page UUID to crawl; repeatable with --no-input', collectOption, [])
    .showHelpAfterError()
    .action(async (connectionId: string, options: NotionPickOptions, command) => {
      await runConnectionNotionArgs(context, buildPickArgs(connectionId, resolveCommandProjectDir(command), options));
    });
}
