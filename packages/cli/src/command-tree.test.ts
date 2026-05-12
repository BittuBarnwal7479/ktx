import { Command } from '@commander-js/extra-typings';
import { describe, expect, it } from 'vitest';
import { formatCommandTree, walkCommandTree } from './command-tree.js';

describe('walkCommandTree', () => {
  it('captures name, description, aliases, and nested children', () => {
    const root = new Command('root').description('the root');
    const child = new Command('child').description('a child').alias('c').alias('ch');
    const grandchild = new Command('grand').description('a grandchild');
    child.addCommand(grandchild);
    root.addCommand(child);

    const tree = walkCommandTree(root);

    expect(tree).toEqual({
      name: 'root',
      description: 'the root',
      aliases: [],
      children: [
        {
          name: 'child',
          description: 'a child',
          aliases: ['c', 'ch'],
          children: [{ name: 'grand', description: 'a grandchild', aliases: [], children: [] }],
        },
      ],
    });
  });

  it('returns an empty children array when there are no subcommands', () => {
    const leaf = new Command('leaf').description('alone');
    expect(walkCommandTree(leaf)).toEqual({
      name: 'leaf',
      description: 'alone',
      aliases: [],
      children: [],
    });
  });

  it('uses an empty string when description is unset', () => {
    const command = new Command('bare');
    expect(walkCommandTree(command).description).toBe('');
  });
});

describe('formatCommandTree', () => {
  it('renders a single node with no children', () => {
    const node = { name: 'solo', description: 'just me', aliases: [], children: [] };
    expect(formatCommandTree(node)).toBe('solo - just me\n');
  });

  it('renders aliases in parentheses before the description', () => {
    const node = { name: 'cmd', description: 'does things', aliases: ['c', 'co'], children: [] };
    expect(formatCommandTree(node)).toBe('cmd (c, co) - does things\n');
  });

  it('omits the dash when description is empty', () => {
    const node = { name: 'bare', description: '', aliases: [], children: [] };
    expect(formatCommandTree(node)).toBe('bare\n');
  });

  it('indents children by two spaces per depth level and sorts siblings alphabetically', () => {
    const tree = {
      name: 'root',
      description: 'top',
      aliases: [],
      children: [
        { name: 'beta', description: 'b', aliases: [], children: [] },
        {
          name: 'alpha',
          description: 'a',
          aliases: ['al'],
          children: [{ name: 'inner', description: 'i', aliases: [], children: [] }],
        },
      ],
    };
    expect(formatCommandTree(tree)).toBe(
      'root - top\n' + '  alpha (al) - a\n' + '    inner - i\n' + '  beta - b\n',
    );
  });
});
