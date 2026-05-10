import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CommandUnknownOpts, Option } from '@commander-js/extra-typings';

export interface CompletionRequest {
  position: number;
  words: string[];
}

interface CompletionCandidate {
  value: string;
  description?: string;
}

interface CommandWithHiddenFlag extends CommandUnknownOpts {
  _hidden?: boolean;
}

interface ResolveState {
  command: CommandUnknownOpts;
  pendingOption?: Option;
  positionalIndex: number;
}

export interface ZshCompletionInstallResult {
  completionPath: string;
  zshrcPath: string;
}

const KTX_COMPLETION_BLOCK_START = '# >>> ktx completion >>>';
const KTX_COMPLETION_BLOCK_END = '# <<< ktx completion <<<';
const KTX_COMPLETION_BLOCK_PATTERN = new RegExp(
  `\\n?${escapeRegExp(KTX_COMPLETION_BLOCK_START)}[\\s\\S]*?${escapeRegExp(KTX_COMPLETION_BLOCK_END)}\\n?`,
  'g',
);

export function zshCompletionScript(): string {
  const zshWords = '$' + '{words[@]}';
  const zshCompletionCapture = [
    '$',
    `{(@f)$("${'$'}{ktx_completion_command[@]}" dev __complete --shell zsh --position "$CURRENT" -- "${zshWords}" 2>/dev/null)}`,
  ].join('');
  const zshCompletionsCount = '$' + '{#completions[@]}';
  const zshCompletionCommand = '$' + '(eval "print -r -- $' + '{KTX_COMPLETION_COMMAND:-ktx}")';

  return [
    '#compdef ktx',
    '',
    '_ktx() {',
    '  local -a completions',
    '  local -a ktx_completion_command',
    `  ktx_completion_command=("\${(@z)${zshCompletionCommand}}")`,
    `  completions=("${zshCompletionCapture}")`,
    `  if (( ${zshCompletionsCount} )); then`,
    "    _describe 'ktx completions' completions",
    '  else',
    '    _files',
    '  fi',
    '}',
    '',
    'compdef _ktx ktx',
    '',
  ].join('\n');
}

export async function installZshCompletion(): Promise<ZshCompletionInstallResult> {
  const homeDir = process.env.HOME || homedir();
  const zshConfigDir = process.env.ZDOTDIR || homeDir;
  const completionDir = join(homeDir, '.zfunc');
  const completionPath = join(completionDir, '_ktx');
  const zshrcPath = join(zshConfigDir, '.zshrc');

  await mkdir(completionDir, { recursive: true });
  await mkdir(dirname(zshrcPath), { recursive: true });
  await writeFile(completionPath, zshCompletionScript(), 'utf-8');

  const existingZshrc = await readOptionalTextFile(zshrcPath);
  const nextZshrc = updateZshrcCompletionBlock(existingZshrc);
  await writeFile(zshrcPath, nextZshrc, 'utf-8');

  return { completionPath, zshrcPath };
}

export function completeCommanderInput(program: CommandUnknownOpts, request: CompletionRequest): string[] {
  const words = completionWordsForPosition(request.words, request.position);
  const tokens = stripProgramName(program, words);
  const current = tokens.at(-1) ?? '';
  const previous = tokens.slice(0, -1);
  const state = resolveCommandState(program, previous);

  return candidatesForState(state, current).map(formatZshCandidate);
}

function completionWordsForPosition(words: string[], position: number): string[] {
  if (!Number.isInteger(position) || position < 1) {
    return words;
  }
  return words.slice(0, position);
}

function stripProgramName(program: CommandUnknownOpts, words: string[]): string[] {
  const [first, ...rest] = words;
  if (!first) {
    return [];
  }
  return first === program.name() || first.endsWith(`/${program.name()}`) ? rest : words;
}

function resolveCommandState(program: CommandUnknownOpts, tokens: string[]): ResolveState {
  let command = program;
  let positionalIndex = 0;
  let pendingOption: Option | undefined;
  let positionalOnly = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (pendingOption) {
      pendingOption = undefined;
      continue;
    }

    if (token === '--') {
      positionalOnly = true;
      continue;
    }

    if (!positionalOnly && token.startsWith('-')) {
      const option = findOption(command, optionNameFromToken(token));
      if (option && !token.includes('=') && optionTakesValue(option)) {
        if (index === tokens.length - 1) {
          pendingOption = option;
        } else if (option.required || !tokens[index + 1]?.startsWith('-')) {
          index += 1;
        }
      }
      continue;
    }

    const child = findVisibleSubcommand(command, token);
    if (child) {
      command = child;
      positionalIndex = 0;
      continue;
    }

    positionalIndex += 1;
  }

  return { command, pendingOption, positionalIndex };
}

function candidatesForState(state: ResolveState, current: string): CompletionCandidate[] {
  const optionValue = splitOptionValueToken(current);
  if (optionValue) {
    const option = findOption(state.command, optionValue.optionName);
    return choiceCandidates(option?.argChoices, optionValue.valuePrefix, optionValue.optionPrefix);
  }

  if (state.pendingOption) {
    return choiceCandidates(state.pendingOption.argChoices, current);
  }

  if (current.startsWith('-')) {
    return visibleOptions(state.command)
      .map(optionCandidate)
      .filter((candidate) => candidate.value.startsWith(current));
  }

  const commandCandidates = visibleSubcommands(state.command)
    .map(commandCandidate)
    .filter((candidate) => candidate.value.startsWith(current));
  const argument = state.command.registeredArguments[state.positionalIndex];
  return [...commandCandidates, ...choiceCandidates(argument?.argChoices, current)];
}

function visibleSubcommands(command: CommandUnknownOpts): CommandUnknownOpts[] {
  return command.commands.filter((subcommand) => (subcommand as CommandWithHiddenFlag)._hidden !== true);
}

function findVisibleSubcommand(command: CommandUnknownOpts, name: string): CommandUnknownOpts | undefined {
  return visibleSubcommands(command).find(
    (subcommand) => subcommand.name() === name || subcommand.aliases().includes(name),
  );
}

function visibleOptions(command: CommandUnknownOpts): Option[] {
  const options: Option[] = [];
  const seen = new Set<string>();
  for (const current of commandChain(command)) {
    for (const option of current.options) {
      if (option.hidden) {
        continue;
      }
      const key = option.long ?? option.short ?? option.flags;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      options.push(option);
    }
  }
  return options;
}

function commandChain(command: CommandUnknownOpts): CommandUnknownOpts[] {
  const chain: CommandUnknownOpts[] = [];
  let current: CommandUnknownOpts | null = command;
  while (current) {
    chain.unshift(current);
    current = current.parent;
  }
  return chain;
}

function findOption(command: CommandUnknownOpts, name: string): Option | undefined {
  return visibleOptions(command).find((option) => option.long === name || option.short === name);
}

function optionTakesValue(option: Option): boolean {
  return option.required || option.optional;
}

function optionNameFromToken(token: string): string {
  return token.split('=', 1)[0] ?? token;
}

function splitOptionValueToken(
  token: string,
): { optionName: string; optionPrefix: string; valuePrefix: string } | null {
  const separatorIndex = token.indexOf('=');
  if (!token.startsWith('-') || separatorIndex < 0) {
    return null;
  }
  return {
    optionName: token.slice(0, separatorIndex),
    optionPrefix: token.slice(0, separatorIndex + 1),
    valuePrefix: token.slice(separatorIndex + 1),
  };
}

function commandCandidate(command: CommandUnknownOpts): CompletionCandidate {
  return {
    value: command.name(),
    description: command.summary() || command.description(),
  };
}

function optionCandidate(option: Option): CompletionCandidate {
  return {
    value: option.long ?? option.short ?? option.flags,
    description: option.description,
  };
}

function choiceCandidates(
  choices: readonly string[] | undefined,
  prefix: string,
  completionPrefix = '',
): CompletionCandidate[] {
  return (choices ?? [])
    .filter((choice) => choice.startsWith(prefix))
    .map((choice) => ({ value: `${completionPrefix}${choice}` }));
}

function formatZshCandidate(candidate: CompletionCandidate): string {
  if (!candidate.description) {
    return escapeZshCompletion(candidate.value);
  }
  return `${escapeZshCompletion(candidate.value)}:${escapeZshDescription(candidate.description)}`;
}

function escapeZshCompletion(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
}

function escapeZshDescription(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/\\/g, '\\\\').replace(/:/g, '\\:').trim();
}

async function readOptionalTextFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf-8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

function updateZshrcCompletionBlock(contents: string): string {
  const withoutManagedBlock = contents.replace(KTX_COMPLETION_BLOCK_PATTERN, normalizeTrailingNewline);
  const hasCompinit = /^.*\bcompinit\b.*$/m.test(withoutManagedBlock);
  const block = zshrcCompletionBlock({ includeCompinit: !hasCompinit });

  if (!hasCompinit) {
    return appendBlock(withoutManagedBlock, block);
  }

  const compinitMatch = /^.*\bcompinit\b.*$/m.exec(withoutManagedBlock);
  if (!compinitMatch || compinitMatch.index === undefined) {
    return appendBlock(withoutManagedBlock, block);
  }

  return [
    withoutManagedBlock.slice(0, compinitMatch.index),
    block,
    '\n',
    withoutManagedBlock.slice(compinitMatch.index),
  ].join('');
}

function zshrcCompletionBlock(options: { includeCompinit: boolean }): string {
  return [
    KTX_COMPLETION_BLOCK_START,
    '_ktx_completion_command() {',
    '  local dir="$PWD"',
    '  while [[ "$dir" != "/" ]]; do',
    `    if [[ -f "$dir/package.json" ]] && command grep -q '"name": "ktx-workspace"' "$dir/package.json" 2>/dev/null; then`,
    '      print -r -- "node $dir/scripts/run-ktx.mjs --"',
    '      return',
    '    fi',
    '    dir="' + '$' + '{dir:h}"',
    '  done',
    '  print -r -- "ktx"',
    '}',
    "export KTX_COMPLETION_COMMAND='$(_ktx_completion_command)'",
    'setopt complete_aliases',
    'fpath=("$HOME/.zfunc" $fpath)',
    ...(options.includeCompinit ? ['autoload -Uz compinit', 'compinit'] : []),
    KTX_COMPLETION_BLOCK_END,
  ].join('\n');
}

function appendBlock(contents: string, block: string): string {
  if (!contents.trim()) {
    return `${block}\n`;
  }
  return `${contents.replace(/\s*$/, '\n\n')}${block}\n`;
}

function normalizeTrailingNewline(match: string): string {
  return match.startsWith('\n') || match.endsWith('\n') ? '\n' : '';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
