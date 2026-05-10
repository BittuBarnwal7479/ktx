import { describe, expect, it } from 'vitest';
import type { KtxCliIo } from '../cli-runtime.js';
import { printList, type PrintListColumn } from './print-list.js';
import { SYMBOLS } from './symbols.js';

function recorder(): { io: KtxCliIo; out: () => string; err: () => string } {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: { write: (chunk: string) => { stdout += chunk; } },
      stderr: { write: (chunk: string) => { stderr += chunk; } },
    },
    out: () => stdout,
    err: () => stderr,
  };
}

interface SlRow {
  connectionId: string;
  name: string;
  columnCount: number;
  measureCount: number;
  joinCount: number;
  description?: string;
}

const SL_COLUMNS: ReadonlyArray<PrintListColumn<SlRow>> = [
  { key: 'connectionId', label: 'CONNECTION', plain: '' },
  { key: 'name',         label: 'NAME',       plain: '' },
  { key: 'columnCount',  label: 'COLS',       plain: 'columns=',  dim: true },
  { key: 'measureCount', label: 'MEASURES',   plain: 'measures=', dim: true },
  { key: 'joinCount',    label: 'JOINS',      plain: 'joins=',    dim: true },
  { key: 'description',  label: 'DESCRIPTION', plain: false, optional: true, dim: true },
];

const ORDERS: SlRow = { connectionId: 'warehouse', name: 'orders', columnCount: 5, measureCount: 3, joinCount: 1 };
const USERS:  SlRow = { connectionId: 'warehouse', name: 'users',  columnCount: 8, measureCount: 2, joinCount: 2, description: 'User profile + auth' };

describe('printList — plain mode', () => {
  it('emits one tab-separated row per item, skipping plain:false columns', () => {
    const r = recorder();
    printList<SlRow>({
      rows: [ORDERS, USERS],
      columns: SL_COLUMNS,
      mode: 'plain',
      command: 'sl list',
      emptyMessage: 'No sources',
      io: r.io,
    });
    expect(r.out()).toBe(
      'warehouse\torders\tcolumns=5\tmeasures=3\tjoins=1\n' +
      'warehouse\tusers\tcolumns=8\tmeasures=2\tjoins=2\n',
    );
  });

  it('emits nothing on empty list (preserves current sl list zero-row behavior)', () => {
    const r = recorder();
    printList<SlRow>({
      rows: [],
      columns: SL_COLUMNS,
      mode: 'plain',
      command: 'sl list',
      emptyMessage: 'No sources',
      io: r.io,
    });
    expect(r.out()).toBe('');
  });
});

describe('printList — json mode', () => {
  it('emits the envelope with kind=list, data.items, and meta.command', () => {
    const r = recorder();
    printList<SlRow>({
      rows: [ORDERS, USERS],
      columns: SL_COLUMNS,
      mode: 'json',
      command: 'sl list',
      emptyMessage: 'No sources',
      io: r.io,
    });
    const written = r.out();
    expect(written.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(written);
    expect(parsed).toEqual({
      kind: 'list',
      data: { items: [ORDERS, USERS] },
      meta: { command: 'sl list' },
    });
  });

  it('emits an empty items array when no rows', () => {
    const r = recorder();
    printList<SlRow>({
      rows: [],
      columns: SL_COLUMNS,
      mode: 'json',
      command: 'sl list',
      emptyMessage: 'No sources',
      io: r.io,
    });
    expect(JSON.parse(r.out())).toEqual({
      kind: 'list',
      data: { items: [] },
      meta: { command: 'sl list' },
    });
  });
});

function stripAnsi(s: string): string {
  // Matches ESC [ ... m sequences emitted by node:util.styleText.
  return s.replace(/\[[0-9;]*m/g, '');
}

describe('printList — pretty mode', () => {
  it('renders a Clack-style header, grouped rows, and footer', () => {
    const r = recorder();
    printList<SlRow>({
      rows: [ORDERS, USERS],
      columns: SL_COLUMNS,
      groupBy: 'connectionId',
      mode: 'pretty',
      command: 'sl list',
      emptyMessage: 'No sources',
      io: r.io,
    });
    const out = stripAnsi(r.out());
    expect(out).toContain(`${SYMBOLS.barStart}  sl list`);
    expect(out).toContain(`${SYMBOLS.group} warehouse`);
    expect(out).toContain('(2 sources)');
    expect(out).toMatch(new RegExp(`${escapeRegExp(SYMBOLS.item)} orders\\s+5 cols ${escapeRegExp(SYMBOLS.middot)} 3 measures ${escapeRegExp(SYMBOLS.middot)} 1 join\\b`));
    expect(out).toMatch(new RegExp(`${escapeRegExp(SYMBOLS.item)} users\\s+8 cols ${escapeRegExp(SYMBOLS.middot)} 2 measures ${escapeRegExp(SYMBOLS.middot)} 2 joins\\b`));
    expect(out).toContain(`${SYMBOLS.emDash} User profile + auth`);
    expect(out).toContain(`${SYMBOLS.barEnd}  2 sources`);
  });

  it('renders an empty-state message when no rows', () => {
    const r = recorder();
    printList<SlRow>({
      rows: [],
      columns: SL_COLUMNS,
      groupBy: 'connectionId',
      mode: 'pretty',
      command: 'sl list',
      emptyMessage: 'No semantic-layer sources found in /tmp/proj',
      io: r.io,
    });
    const out = stripAnsi(r.out());
    expect(out).toContain(`${SYMBOLS.barStart}  sl list`);
    expect(out).toContain(`${SYMBOLS.barEnd}  No semantic-layer sources found in /tmp/proj`);
  });

  it('singularizes the footer when there is one row', () => {
    const r = recorder();
    printList<SlRow>({
      rows: [ORDERS],
      columns: SL_COLUMNS,
      groupBy: 'connectionId',
      mode: 'pretty',
      command: 'sl list',
      emptyMessage: 'No sources',
      io: r.io,
    });
    const out = stripAnsi(r.out());
    expect(out).toContain(`${SYMBOLS.barEnd}  1 source`);
  });
});

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
