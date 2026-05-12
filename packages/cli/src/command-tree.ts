import type { Command } from '@commander-js/extra-typings';

export interface CommandTreeNode {
  name: string;
  description: string;
  aliases: string[];
  children: CommandTreeNode[];
}

export function walkCommandTree(command: Command): CommandTreeNode {
  return {
    name: command.name(),
    description: command.description(),
    aliases: command.aliases(),
    children: command.commands.map((child) => walkCommandTree(child as Command)),
  };
}

export function formatCommandTree(node: CommandTreeNode): string {
  const lines: string[] = [];
  appendNode(node, 0, lines);
  return `${lines.join('\n')}\n`;
}

function appendNode(node: CommandTreeNode, depth: number, lines: string[]): void {
  const indent = '  '.repeat(depth);
  const aliasPart = node.aliases.length > 0 ? ` (${node.aliases.join(', ')})` : '';
  const descriptionPart = node.description.length > 0 ? ` - ${node.description}` : '';
  lines.push(`${indent}${node.name}${aliasPart}${descriptionPart}`);

  const sortedChildren = [...node.children].sort((a, b) => a.name.localeCompare(b.name));
  for (const child of sortedChildren) {
    appendNode(child, depth + 1, lines);
  }
}
