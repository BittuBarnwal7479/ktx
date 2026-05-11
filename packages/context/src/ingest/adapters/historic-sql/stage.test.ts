import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SqlAnalysisPort } from '../../../sql-analysis/index.js';
import { stageHistoricSqlTemplates } from './stage.js';
import {
  historicSqlManifestSchema,
  historicSqlMetadataSchema,
  historicSqlUsageSchema,
  type HistoricSqlQueryHistoryReader,
  type HistoricSqlRawQueryRow,
} from './types.js';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'historic-sql-stage-'));
}

async function readJson<T>(root: string, relPath: string): Promise<T> {
  return JSON.parse(await readFile(join(root, relPath), 'utf-8')) as T;
}

function fakeReader(rows: HistoricSqlRawQueryRow[]): HistoricSqlQueryHistoryReader {
  return {
    async probe() {},
    async *fetch() {
      for (const row of rows) {
        yield row;
      }
    },
  };
}

const fakeSqlAnalysis: SqlAnalysisPort = {
  async analyzeForFingerprint(sql) {
    if (sql.includes('paid')) {
      return {
        fingerprint: 'fp_paid_orders',
        normalizedSql: 'SELECT count(*) FROM analytics.orders WHERE status = ? AND created_at >= ?',
        tablesTouched: ['analytics.orders'],
        literalSlots: [
          { position: 1, type: 'string', exampleValue: 'paid' },
          { position: 2, type: 'date', exampleValue: '2026-04-01' },
        ],
      };
    }
    return {
      fingerprint: 'fp_refunds',
      normalizedSql: 'SELECT count(*) FROM analytics.refunds WHERE state = ?',
      tablesTouched: ['analytics.refunds'],
      literalSlots: [{ position: 1, type: 'string', exampleValue: 'complete' }],
    };
  },
  async analyzeBatch() {
    return new Map();
  },
};

const categoricalSqlAnalysis: SqlAnalysisPort = {
  async analyzeForFingerprint(sql) {
    const status = sql.includes("'refunded'") ? 'refunded' : 'paid';
    return {
      fingerprint: 'fp_order_status',
      normalizedSql: 'SELECT count(*) FROM analytics.orders WHERE status = ?',
      tablesTouched: ['analytics.orders'],
      literalSlots: [{ position: 1, type: 'string', exampleValue: status }],
    };
  },
  async analyzeBatch() {
    return new Map();
  },
};

function categoricalRows(): HistoricSqlRawQueryRow[] {
  return [
    {
      id: 'paid-1',
      sql: "SELECT count(*) FROM analytics.orders WHERE status = 'paid'",
      user: 'analyst-a',
      startedAt: '2026-05-04T10:00:00.000Z',
      endedAt: null,
      runtimeMs: 100,
      rowsProduced: 11,
      success: true,
      errorMessage: null,
    },
    {
      id: 'paid-2',
      sql: "SELECT count(*) FROM analytics.orders WHERE status = 'paid'",
      user: 'analyst-b',
      startedAt: '2026-05-04T10:01:00.000Z',
      endedAt: null,
      runtimeMs: 110,
      rowsProduced: 12,
      success: true,
      errorMessage: null,
    },
    {
      id: 'paid-3',
      sql: "SELECT count(*) FROM analytics.orders WHERE status = 'paid'",
      user: 'analyst-c',
      startedAt: '2026-05-04T10:02:00.000Z',
      endedAt: null,
      runtimeMs: 120,
      rowsProduced: 13,
      success: true,
      errorMessage: null,
    },
    {
      id: 'refunded-1',
      sql: "SELECT count(*) FROM analytics.orders WHERE status = 'refunded'",
      user: 'analyst-a',
      startedAt: '2026-05-04T10:03:00.000Z',
      endedAt: null,
      runtimeMs: 130,
      rowsProduced: 21,
      success: true,
      errorMessage: null,
    },
    {
      id: 'refunded-2',
      sql: "SELECT count(*) FROM analytics.orders WHERE status = 'refunded'",
      user: 'analyst-b',
      startedAt: '2026-05-04T10:04:00.000Z',
      endedAt: null,
      runtimeMs: 140,
      rowsProduced: 22,
      success: true,
      errorMessage: null,
    },
    {
      id: 'refunded-3',
      sql: "SELECT count(*) FROM analytics.orders WHERE status = 'refunded'",
      user: 'analyst-c',
      startedAt: '2026-05-04T10:05:00.000Z',
      endedAt: null,
      runtimeMs: 150,
      rowsProduced: 23,
      success: true,
      errorMessage: null,
    },
  ];
}

const diverseSqlAnalysis: SqlAnalysisPort = {
  async analyzeForFingerprint(sql) {
    const value = sql.match(/status = '([^']+)'/)?.[1] ?? 'unknown';
    return {
      fingerprint: 'fp_diverse_samples',
      normalizedSql: 'SELECT count(*) FROM analytics.orders WHERE status = ?',
      tablesTouched: ['analytics.orders'],
      literalSlots: [{ position: 1, type: 'string', exampleValue: value }],
    };
  },
  async analyzeBatch() {
    return new Map();
  },
};

const classificationMatrixSqlAnalysis: SqlAnalysisPort = {
  async analyzeForFingerprint(sql) {
    if (sql.includes('stale_orders')) {
      return {
        fingerprint: 'fp_stale_date',
        normalizedSql: 'SELECT count(*) FROM analytics.stale_orders WHERE created_at >= ?',
        tablesTouched: ['analytics.stale_orders'],
        literalSlots: [{ position: 1, type: 'date', exampleValue: '2026-04-01' }],
      };
    }

    const stringValue = (field: string): string => sql.match(new RegExp(`${field} = '([^']+)'`))?.[1] ?? 'unknown';
    const amount = sql.match(/amount >= (\d+)/)?.[1] ?? '0';
    const asOf = sql.match(/created_at >= '([^']+)'/)?.[1] ?? '2026-05-01';

    return {
      fingerprint: 'fp_classification_matrix',
      normalizedSql:
        'SELECT count(*) FROM analytics.orders WHERE region = ? AND plan = ? AND status = ? AND amount >= ? AND created_at >= ?',
      tablesTouched: ['analytics.orders'],
      literalSlots: [
        { position: 1, type: 'string', exampleValue: stringValue('region') },
        { position: 2, type: 'string', exampleValue: stringValue('plan') },
        { position: 3, type: 'string', exampleValue: stringValue('status') },
        { position: 4, type: 'number', exampleValue: amount },
        { position: 5, type: 'date', exampleValue: asOf },
      ],
    };
  },
  async analyzeBatch() {
    return new Map();
  },
};

function classificationMatrixRows(): HistoricSqlRawQueryRow[] {
  const rows: HistoricSqlRawQueryRow[] = Array.from({ length: 20 }, (_, index) => {
    const status = index < 10 ? 'paid' : 'refunded';
    const plan = index === 19 ? 'self_serve' : 'enterprise';
    const amount = 100 + index;
    const asOf = `2026-05-${String(1 + Math.floor(index / 5)).padStart(2, '0')}`;
    return {
      id: `matrix-${index + 1}`,
      sql: `SELECT count(*) FROM analytics.orders WHERE region = 'us' AND plan = '${plan}' AND status = '${status}' AND amount >= ${amount} AND created_at >= '${asOf}'`,
      user: `analyst-${(index % 4) + 1}`,
      startedAt: `2026-05-04T10:${String(index).padStart(2, '0')}:00.000Z`,
      endedAt: null,
      runtimeMs: 100 + index,
      rowsProduced: 1,
      success: true,
      errorMessage: null,
    };
  });

  return [
    ...rows,
    {
      id: 'stale-date-1',
      sql: "SELECT count(*) FROM analytics.stale_orders WHERE created_at >= '2026-04-01'",
      user: 'analyst-1',
      startedAt: '2026-05-04T11:00:00.000Z',
      endedAt: null,
      runtimeMs: 75,
      rowsProduced: 1,
      success: true,
      errorMessage: null,
    },
  ];
}

describe('stageHistoricSqlTemplates', () => {
  it('compresses rows by fingerprint into document-shaped staged templates', async () => {
    const stagedDir = await tempDir();

    await stageHistoricSqlTemplates({
      stagedDir,
      connectionId: 'conn_1',
      queryClient: {},
      reader: fakeReader([
        {
          id: 'q1',
          sql: "SELECT count(*) FROM analytics.orders WHERE status = 'paid' AND created_at >= '2026-04-01' AND email = 'analyst@example.com'",
          user: 'analyst@example.com',
          startedAt: '2026-05-04T10:00:00.000Z',
          endedAt: '2026-05-04T10:00:01.000Z',
          runtimeMs: 100,
          rowsProduced: 1,
          success: true,
          errorMessage: null,
        },
        {
          id: 'q2',
          sql: "SELECT count(*) FROM analytics.orders WHERE status = 'paid' AND created_at >= '2026-05-01' AND email = 'analyst-2@example.com'",
          user: 'analyst-2@example.com',
          startedAt: '2026-05-04T11:00:00.000Z',
          endedAt: '2026-05-04T11:00:01.000Z',
          runtimeMs: 300,
          rowsProduced: 1,
          success: true,
          errorMessage: null,
        },
      ]),
      sqlAnalysis: fakeSqlAnalysis,
      pullConfig: {
        dialect: 'snowflake',
        windowDays: 90,
        lastSuccessfulCursor: null,
        serviceAccountUserPatterns: ['^svc_'],
        redactionPatterns: ['[\\w.+-]+@[\\w-]+\\.[\\w.-]+'],
        maxTemplatesPerRun: 5000,
        minCalls: 5,
      },
      now: new Date('2026-05-04T12:00:00.000Z'),
    });

    const manifest = historicSqlManifestSchema.parse(await readJson(stagedDir, 'manifest.json'));
    expect(manifest).toMatchObject({
      source: 'historic-sql',
      connectionId: 'conn_1',
      dialect: 'snowflake',
      nextSuccessfulCursor: '2026-05-04T11:00:00.000Z',
      templateCount: 1,
      capped: false,
    });

    const files = (await readdir(join(stagedDir, 'templates', 'fp_paid_orders'))).sort();
    expect(files).toEqual(['metadata.json', 'page.md', 'usage.json']);

    const metadata = historicSqlMetadataSchema.parse(
      await readJson(stagedDir, 'templates/fp_paid_orders/metadata.json'),
    );
    expect(metadata).toEqual({
      id: 'fp_paid_orders',
      title: 'snowflake · analytics.orders [fp_pai]',
      path: 'templates/fp_paid_orders/page.md',
      objectType: 'historic_sql_template',
      lastEditedAt: null,
      properties: {
        fingerprint: 'fp_paid_orders',
        sub_cluster_id: null,
        dialect: 'snowflake',
        tables_touched: ['analytics.orders'],
        literal_slots: [
          { position: 1, type: 'string', classification: 'constant' },
          { position: 2, type: 'date', classification: 'runtime' },
        ],
        triage_signals: {
          executions_bucket: 'low',
          distinct_users_bucket: 'team',
          error_rate_bucket: 'ok',
          recency_bucket: 'active',
          service_account_only: 'false',
          slot_summary: '1 constant, 1 runtime',
        },
      },
    });

    const page = await readFile(join(stagedDir, 'templates/fp_paid_orders/page.md'), 'utf-8');
    expect(page).toContain('## Normalized SQL');
    expect(page).toContain('SELECT count(*) FROM analytics.orders WHERE status = ? AND created_at >= ?');
    expect(page).toContain('- analytics.orders');

    const usage = historicSqlUsageSchema.parse(await readJson(stagedDir, 'templates/fp_paid_orders/usage.json'));
    expect(usage.stats).toMatchObject({
      executions: 2,
      distinct_users: 2,
      first_seen: '2026-05-04T10:00:00.000Z',
      last_seen: '2026-05-04T11:00:00.000Z',
      p50_runtime_ms: 100,
      p95_runtime_ms: 300,
      error_rate: 0,
    });
    expect(usage.samples).toHaveLength(1);
    expect(usage.samples[0].bound_sql).toContain('<redacted>');
    expect(usage.samples[0].bound_sql).not.toContain('analyst@example.com');
    expect(usage.samples[0].bound_sql).not.toContain('analyst-2@example.com');
  });

  it('skips hard-noise SQL and caps templates deterministically', async () => {
    const stagedDir = await tempDir();

    await stageHistoricSqlTemplates({
      stagedDir,
      connectionId: 'conn_1',
      queryClient: {},
      reader: fakeReader([
        {
          id: 'show-1',
          sql: 'SHOW TABLES',
          user: 'analyst',
          startedAt: '2026-05-04T10:00:00.000Z',
          endedAt: null,
          runtimeMs: null,
          success: true,
          errorMessage: null,
        },
        {
          id: 'q3',
          sql: "SELECT count(*) FROM analytics.refunds WHERE state = 'complete'",
          user: 'analyst',
          startedAt: '2026-05-04T11:00:00.000Z',
          endedAt: null,
          runtimeMs: 50,
          success: true,
          errorMessage: null,
        },
        {
          id: 'q4',
          sql: "SELECT count(*) FROM analytics.orders WHERE status = 'paid' AND created_at >= '2026-04-01'",
          user: 'analyst',
          startedAt: '2026-05-04T11:30:00.000Z',
          endedAt: null,
          runtimeMs: 40,
          success: true,
          errorMessage: null,
        },
      ]),
      sqlAnalysis: fakeSqlAnalysis,
      pullConfig: {
        dialect: 'bigquery',
        windowDays: 7,
        lastSuccessfulCursor: '2026-05-01T00:00:00.000Z',
        serviceAccountUserPatterns: [],
        redactionPatterns: [],
        maxTemplatesPerRun: 1,
        minCalls: 5,
      },
      now: new Date('2026-05-04T12:00:00.000Z'),
    });

    const manifest = historicSqlManifestSchema.parse(await readJson(stagedDir, 'manifest.json'));
    expect(manifest.templateCount).toBe(1);
    expect(manifest.capped).toBe(true);
    expect(manifest.warnings).toEqual(['templates_truncated: kept 1 of 2 templates']);
    expect(manifest.templates.map((template) => template.id)).toEqual(['fp_paid_orders']);
  });

  it('splits categorical fingerprints into one document directory per dominant value', async () => {
    const stagedDir = await tempDir();

    await stageHistoricSqlTemplates({
      stagedDir,
      connectionId: 'conn_1',
      queryClient: {},
      reader: fakeReader(categoricalRows()),
      sqlAnalysis: categoricalSqlAnalysis,
      pullConfig: {
        dialect: 'snowflake',
        windowDays: 90,
        lastSuccessfulCursor: null,
        serviceAccountUserPatterns: [],
        redactionPatterns: [],
        maxTemplatesPerRun: 5000,
        minCalls: 5,
      },
      now: new Date('2026-05-04T12:00:00.000Z'),
    });

    const manifest = historicSqlManifestSchema.parse(await readJson(stagedDir, 'manifest.json'));
    const templates = manifest.templates
      .map((template) => ({
        id: template.id,
        fingerprint: template.fingerprint,
        subClusterId: template.subClusterId,
        path: template.path,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));

    expect(manifest.templateCount).toBe(2);
    expect(templates).toEqual([
      {
        id: 'fp_order_status__cat_2b2ff2318877',
        fingerprint: 'fp_order_status',
        subClusterId: 'cat_2b2ff2318877',
        path: 'templates/fp_order_status__cat_2b2ff2318877/page.md',
      },
      {
        id: 'fp_order_status__cat_34f037ddcbfa',
        fingerprint: 'fp_order_status',
        subClusterId: 'cat_34f037ddcbfa',
        path: 'templates/fp_order_status__cat_34f037ddcbfa/page.md',
      },
    ]);

    const paidMetadata = historicSqlMetadataSchema.parse(
      await readJson(stagedDir, 'templates/fp_order_status__cat_34f037ddcbfa/metadata.json'),
    );
    expect(paidMetadata).toMatchObject({
      id: 'fp_order_status__cat_34f037ddcbfa',
      title: 'snowflake · analytics.orders [fp_ord:ddcbfa]',
      path: 'templates/fp_order_status__cat_34f037ddcbfa/page.md',
      properties: {
        fingerprint: 'fp_order_status',
        sub_cluster_id: 'cat_34f037ddcbfa',
        dialect: 'snowflake',
        tables_touched: ['analytics.orders'],
        literal_slots: [{ position: 1, type: 'string', classification: 'categorical' }],
      },
    });

    const paidUsage = historicSqlUsageSchema.parse(
      await readJson(stagedDir, 'templates/fp_order_status__cat_34f037ddcbfa/usage.json'),
    );
    expect(paidUsage.stats).toMatchObject({
      executions: 3,
      distinct_users: 3,
      first_seen: '2026-05-04T10:00:00.000Z',
      last_seen: '2026-05-04T10:02:00.000Z',
      rows_produced: 36,
    });
    expect(paidUsage.literal_slots).toEqual([{ position: 1, distinct_values: 1, top_values: [['paid', 3]] }]);

    const refundedUsage = historicSqlUsageSchema.parse(
      await readJson(stagedDir, 'templates/fp_order_status__cat_2b2ff2318877/usage.json'),
    );
    expect(refundedUsage.stats).toMatchObject({
      executions: 3,
      distinct_users: 3,
      first_seen: '2026-05-04T10:03:00.000Z',
      last_seen: '2026-05-04T10:05:00.000Z',
      rows_produced: 66,
    });
    expect(refundedUsage.literal_slots).toEqual([
      { position: 1, distinct_values: 1, top_values: [['refunded', 3]] },
    ]);
  });

  it('classifies literal slots across the spec matrix and stale-date demotion', async () => {
    const stagedDir = await tempDir();

    await stageHistoricSqlTemplates({
      stagedDir,
      connectionId: 'conn_1',
      queryClient: {},
      reader: fakeReader(classificationMatrixRows()),
      sqlAnalysis: classificationMatrixSqlAnalysis,
      pullConfig: {
        dialect: 'snowflake',
        windowDays: 90,
        lastSuccessfulCursor: null,
        serviceAccountUserPatterns: [],
        redactionPatterns: [],
        maxTemplatesPerRun: 5000,
        minCalls: 5,
      },
      now: new Date('2026-05-04T12:00:00.000Z'),
    });

    const manifest = historicSqlManifestSchema.parse(await readJson(stagedDir, 'manifest.json'));
    const matrixTemplates = manifest.templates.filter((template) => template.fingerprint === 'fp_classification_matrix');
    expect(matrixTemplates).toHaveLength(2);
    expect(matrixTemplates.every((template) => template.subClusterId?.startsWith('cat_'))).toBe(true);

    const matrixTemplate = matrixTemplates[0];
    if (!matrixTemplate) {
      throw new Error('expected classification matrix template');
    }
    const matrixMetadata = historicSqlMetadataSchema.parse(
      await readJson(stagedDir, matrixTemplate.path.replace('/page.md', '/metadata.json')),
    );
    expect(matrixMetadata.properties.literal_slots).toMatchInlineSnapshot(`
      [
        {
          "classification": "constant",
          "position": 1,
          "type": "string",
        },
        {
          "classification": "constant",
          "position": 2,
          "type": "string",
        },
        {
          "classification": "categorical",
          "position": 3,
          "type": "string",
        },
        {
          "classification": "runtime",
          "position": 4,
          "type": "number",
        },
        {
          "classification": "runtime",
          "position": 5,
          "type": "date",
        },
      ]
    `);
    expect(matrixMetadata.properties.triage_signals.slot_summary).toBe('2 constant, 2 runtime');

    const staleMetadata = historicSqlMetadataSchema.parse(
      await readJson(stagedDir, 'templates/fp_stale_date/metadata.json'),
    );
    expect(staleMetadata.properties.literal_slots).toMatchInlineSnapshot(`
      [
        {
          "classification": "runtime",
          "position": 1,
          "type": "date",
        },
      ]
    `);
    expect(staleMetadata.properties.triage_signals.slot_summary).toBe('0 constant, 1 runtime');
  });

  it('applies the templates-per-run cap after categorical expansion', async () => {
    const stagedDir = await tempDir();

    await stageHistoricSqlTemplates({
      stagedDir,
      connectionId: 'conn_1',
      queryClient: {},
      reader: fakeReader(categoricalRows()),
      sqlAnalysis: categoricalSqlAnalysis,
      pullConfig: {
        dialect: 'snowflake',
        windowDays: 90,
        lastSuccessfulCursor: null,
        serviceAccountUserPatterns: [],
        redactionPatterns: [],
        maxTemplatesPerRun: 1,
        minCalls: 5,
      },
      now: new Date('2026-05-04T12:00:00.000Z'),
    });

    const manifest = historicSqlManifestSchema.parse(await readJson(stagedDir, 'manifest.json'));
    expect(manifest.templateCount).toBe(1);
    expect(manifest.capped).toBe(true);
    expect(manifest.warnings).toEqual(['templates_truncated: kept 1 of 2 templates']);
    expect(manifest.templates).toHaveLength(1);
    expect(manifest.templates[0].id).toMatch(/^fp_order_status__cat_/);
  });

  it('omits rows_produced for BigQuery templates when reader rows have no row counts', async () => {
    const stagedDir = await tempDir();

    await stageHistoricSqlTemplates({
      stagedDir,
      connectionId: 'conn_bq',
      queryClient: {},
      reader: fakeReader([
        {
          id: 'bq-1',
          sql: "SELECT count(*) FROM analytics.orders WHERE status = 'paid'",
          user: 'analyst-a@example.com',
          startedAt: '2026-05-04T10:00:00.000Z',
          endedAt: null,
          runtimeMs: 100,
          success: true,
          errorMessage: null,
        },
      ]),
      sqlAnalysis: fakeSqlAnalysis,
      pullConfig: {
        dialect: 'bigquery',
        windowDays: 90,
        lastSuccessfulCursor: null,
        serviceAccountUserPatterns: [],
        redactionPatterns: [],
        maxTemplatesPerRun: 5000,
        minCalls: 5,
      },
      now: new Date('2026-05-04T12:00:00.000Z'),
    });

    const usage = historicSqlUsageSchema.parse(await readJson(stagedDir, 'templates/fp_paid_orders/usage.json'));
    expect(usage.stats).not.toHaveProperty('rows_produced');
    expect(usage.samples[0]).not.toHaveProperty('rows_produced');
  });

  it('keeps at most five diverse samples, preferring recent successful representatives per literal tuple', async () => {
    const stagedDir = await tempDir();
    const statuses = [
      'paid',
      'refunded',
      'pending',
      'failed',
      'trial',
      'cancelled',
      'draft',
      'returned',
      'review',
      'held',
      'archived',
    ];
    const rows: HistoricSqlRawQueryRow[] = statuses.flatMap((status, index) => [
      {
        id: `${status}-old`,
        sql: `SELECT count(*) FROM analytics.orders WHERE status = '${status}'`,
        user: 'analyst-a',
        startedAt: `2026-05-04T10:${String(index).padStart(2, '0')}:00.000Z`,
        endedAt: null,
        runtimeMs: 100,
        rowsProduced: 1,
        success: false,
        errorMessage: 'old failed sample',
      },
      {
        id: `${status}-new`,
        sql: `SELECT count(*) FROM analytics.orders WHERE status = '${status}'`,
        user: 'analyst-a',
        startedAt: `2026-05-04T11:${String(index).padStart(2, '0')}:00.000Z`,
        endedAt: null,
        runtimeMs: 90,
        rowsProduced: 2,
        success: true,
        errorMessage: null,
      },
    ]);

    await stageHistoricSqlTemplates({
      stagedDir,
      connectionId: 'conn_1',
      queryClient: {},
      reader: fakeReader(rows),
      sqlAnalysis: diverseSqlAnalysis,
      pullConfig: {
        dialect: 'snowflake',
        windowDays: 90,
        lastSuccessfulCursor: null,
        serviceAccountUserPatterns: [],
        redactionPatterns: [],
        maxTemplatesPerRun: 5000,
        minCalls: 5,
      },
      now: new Date('2026-05-04T12:00:00.000Z'),
    });

    const usage = historicSqlUsageSchema.parse(await readJson(stagedDir, 'templates/fp_diverse_samples/usage.json'));
    expect(usage.samples).toHaveLength(5);
    expect(usage.samples.every((sample) => sample.success)).toBe(true);
    expect(new Set(usage.samples.map((sample) => sample.bound_sql.match(/status = '([^']+)'/)?.[1])).size).toBe(5);
    expect(usage.samples.map((sample) => sample.started_at)).toEqual([
      '2026-05-04T11:10:00.000Z',
      '2026-05-04T11:09:00.000Z',
      '2026-05-04T11:08:00.000Z',
      '2026-05-04T11:07:00.000Z',
      '2026-05-04T11:06:00.000Z',
    ]);
  });

  it('uses recency as a tie-breaker when the templates-per-run cap overflows', async () => {
    const stagedDir = await tempDir();
    const sqlAnalysis: SqlAnalysisPort = {
      async analyzeForFingerprint(sql) {
        const table = sql.includes('fresh_orders') ? 'fresh_orders' : 'stale_orders';
        return {
          fingerprint: `fp_${table}`,
          normalizedSql: `SELECT count(*) FROM analytics.${table}`,
          tablesTouched: [`analytics.${table}`],
          literalSlots: [],
        };
      },
      async analyzeBatch() {
        return new Map();
      },
    };

    await stageHistoricSqlTemplates({
      stagedDir,
      connectionId: 'conn_1',
      queryClient: {},
      reader: fakeReader([
        {
          id: 'stale-1',
          sql: 'SELECT count(*) FROM analytics.stale_orders',
          user: 'analyst-a',
          startedAt: '2026-02-04T10:00:00.000Z',
          endedAt: null,
          runtimeMs: 100,
          rowsProduced: 1,
          success: true,
          errorMessage: null,
        },
        {
          id: 'fresh-1',
          sql: 'SELECT count(*) FROM analytics.fresh_orders',
          user: 'analyst-a',
          startedAt: '2026-05-04T10:00:00.000Z',
          endedAt: null,
          runtimeMs: 100,
          rowsProduced: 1,
          success: true,
          errorMessage: null,
        },
      ]),
      sqlAnalysis,
      pullConfig: {
        dialect: 'snowflake',
        windowDays: 90,
        lastSuccessfulCursor: null,
        serviceAccountUserPatterns: [],
        redactionPatterns: [],
        maxTemplatesPerRun: 1,
        minCalls: 5,
      },
      now: new Date('2026-05-04T12:00:00.000Z'),
    });

    const manifest = historicSqlManifestSchema.parse(await readJson(stagedDir, 'manifest.json'));
    expect(manifest.templates.map((template) => template.id)).toEqual(['fp_fresh_orders']);
  });

  it('does not persist bound SQL samples when redaction patterns are invalid', async () => {
    const stagedDir = await tempDir();

    await stageHistoricSqlTemplates({
      stagedDir,
      connectionId: 'conn_1',
      queryClient: {},
      reader: fakeReader([
        {
          id: 'q1',
          sql: "SELECT * FROM analytics.orders WHERE email = 'analyst@example.com'",
          user: 'analyst@example.com',
          startedAt: '2026-05-04T10:00:00.000Z',
          endedAt: null,
          runtimeMs: 100,
          rowsProduced: 1,
          success: true,
          errorMessage: null,
        },
      ]),
      sqlAnalysis: {
        async analyzeForFingerprint() {
          return {
            fingerprint: 'fp_redaction',
            normalizedSql: 'SELECT * FROM analytics.orders WHERE email = ?',
            tablesTouched: ['analytics.orders'],
            literalSlots: [{ position: 1, type: 'string', exampleValue: 'analyst@example.com' }],
          };
        },
        async analyzeBatch() {
          return new Map();
        },
      },
      pullConfig: {
        dialect: 'snowflake',
        windowDays: 90,
        lastSuccessfulCursor: null,
        serviceAccountUserPatterns: [],
        redactionPatterns: ['['],
        maxTemplatesPerRun: 5000,
        minCalls: 5,
      },
      now: new Date('2026-05-04T12:00:00.000Z'),
    });

    const manifest = historicSqlManifestSchema.parse(await readJson(stagedDir, 'manifest.json'));
    const usage = historicSqlUsageSchema.parse(await readJson(stagedDir, 'templates/fp_redaction/usage.json'));
    expect(manifest.warnings.some((warning) => warning.startsWith('redaction_skipped:invalid_redaction_pattern'))).toBe(
      true,
    );
    expect(usage.samples).toEqual([]);
  });
});
