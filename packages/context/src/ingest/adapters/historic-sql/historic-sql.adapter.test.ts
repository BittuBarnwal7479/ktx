import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SqlAnalysisPort } from '../../../sql-analysis/index.js';
import { HistoricSqlSourceAdapter } from './historic-sql.adapter.js';
import { pgssBaselinePath } from './stage-pgss.js';
import type { HistoricSqlQueryHistoryReader, PostgresPgssReader } from './types.js';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'historic-sql-adapter-'));
}

async function writeJson(root: string, relPath: string, value: unknown): Promise<void> {
  const target = join(root, relPath);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

const sqlAnalysis: SqlAnalysisPort = {
  async analyzeForFingerprint() {
    return {
      fingerprint: 'fp_1',
      normalizedSql: 'SELECT count(*) FROM analytics.orders WHERE status = ?',
      tablesTouched: ['analytics.orders'],
      literalSlots: [{ position: 1, type: 'string', exampleValue: 'paid' }],
    };
  },
  async analyzeBatch() {
    return new Map();
  },
};

const reader: HistoricSqlQueryHistoryReader = {
  async probe() {},
  async *fetch() {
    yield {
      id: 'q1',
      sql: "SELECT count(*) FROM analytics.orders WHERE status = 'paid'",
      user: 'analyst',
      startedAt: '2026-05-04T11:00:00.000Z',
      endedAt: null,
      runtimeMs: 10,
      rowsProduced: 1,
      success: true,
      errorMessage: null,
    };
  },
};

describe('HistoricSqlSourceAdapter', () => {
  it('declares canonical adapter metadata', () => {
    const adapter = new HistoricSqlSourceAdapter({ sqlAnalysis, reader, queryClient: {} });

    expect(adapter.source).toBe('historic-sql');
    expect(adapter.skillNames).toEqual(['historic_sql_ingest']);
    expect(adapter.reconcileSkillNames).toEqual(['historic_sql_curator']);
    expect(adapter.evidenceIndexing).toBe('documents');
    expect(adapter.triageSupported).toBe(true);
  });

  it('fetches staged templates through injected reader and SqlAnalysisPort', async () => {
    const stagedDir = await tempDir();
    const adapter = new HistoricSqlSourceAdapter({
      sqlAnalysis,
      reader,
      queryClient: {},
      now: () => new Date('2026-05-04T12:00:00.000Z'),
    });

    await adapter.fetch(
      {
        dialect: 'snowflake',
        windowDays: 90,
        lastSuccessfulCursor: null,
        serviceAccountUserPatterns: [],
        redactionPatterns: [],
        maxTemplatesPerRun: 5000,
      },
      stagedDir,
      { connectionId: 'conn_1', sourceKey: 'historic-sql' },
    );

    await expect(adapter.detect(stagedDir)).resolves.toBe(true);
  });

  it('reads triage signals from usage.json and metadata properties', async () => {
    const stagedDir = await tempDir();
    await writeJson(stagedDir, 'manifest.json', {
      source: 'historic-sql',
      connectionId: 'conn_1',
      dialect: 'snowflake',
      fetchedAt: '2026-05-04T12:00:00.000Z',
      windowStart: '2026-02-03T12:00:00.000Z',
      windowEnd: '2026-05-04T12:00:00.000Z',
      nextSuccessfulCursor: '2026-05-04T11:55:00.000Z',
      templateCount: 1,
      capped: false,
      warnings: [],
      templates: [{ id: 'fp_1', fingerprint: 'fp_1', subClusterId: null, path: 'templates/fp_1/page.md' }],
    });
    await writeJson(stagedDir, 'templates/fp_1/metadata.json', {
      id: 'fp_1',
      title: 'snowflake · analytics.orders [fp_1]',
      path: 'templates/fp_1/page.md',
      objectType: 'historic_sql_template',
      lastEditedAt: null,
      properties: {
        fingerprint: 'fp_1',
        sub_cluster_id: null,
        dialect: 'snowflake',
        tables_touched: ['analytics.orders'],
        literal_slots: [{ position: 1, type: 'string', classification: 'constant' }],
        triage_signals: {
          executions_bucket: 'high',
          distinct_users_bucket: 'team',
          error_rate_bucket: 'ok',
          recency_bucket: 'active',
          service_account_only: 'false',
          slot_summary: '1 constant, 0 runtime',
        },
      },
    });
    await writeFile(join(stagedDir, 'templates/fp_1/page.md'), '# fp_1\n', 'utf-8');
    await writeJson(stagedDir, 'templates/fp_1/usage.json', {
      stats: {
        executions: 20,
        distinct_users: 3,
        first_seen: '2026-05-01T00:00:00.000Z',
        last_seen: '2026-05-04T11:55:00.000Z',
        p50_runtime_ms: 100,
        p95_runtime_ms: 200,
        error_rate: 0,
      },
      literal_slots: [{ position: 1, distinct_values: 1, top_values: [['paid', 20]] }],
      samples: [],
    });

    const adapter = new HistoricSqlSourceAdapter({ sqlAnalysis, reader, queryClient: {} });

    await expect(adapter.getTriageSignals(stagedDir, 'fp_1')).resolves.toEqual({
      objectType: 'historic_sql_template',
      lastEditedAt: '2026-05-04T11:55:00.000Z',
      propertyHints: {
        executions_bucket: 'high',
        distinct_users_bucket: 'team',
        error_rate_bucket: 'ok',
        recency_bucket: 'active',
        service_account_only: 'false',
        slot_summary: '1 constant, 0 runtime',
      },
    });
  });

  it('dispatches postgres fetches through PGSS staging and writes the baseline only after pull success', async () => {
    const stagedDir = await tempDir();
    const baselineRootDir = await tempDir();
    const baselinePath = pgssBaselinePath(baselineRootDir, 'conn_pg');
    const unusedPerExecutionReader: HistoricSqlQueryHistoryReader = {
      async probe() {
        throw new Error('per-execution reader must not be used for postgres');
      },
      async *fetch() {
        throw new Error('per-execution reader must not be used for postgres');
      },
    };
    const postgresReader: PostgresPgssReader = {
      async probe() {
        return { pgServerVersion: 'PostgreSQL 16.4', warnings: [] };
      },
      async readSnapshot() {
        return {
          statsResetAt: '2026-05-08T08:00:00.000Z',
          deallocCount: 0,
          rows: [
            {
              queryid: '901',
              userid: '11',
              username: 'analyst',
              dbid: '5',
              database: 'warehouse',
              query: 'SELECT count(*) FROM analytics.orders WHERE status = $1',
              calls: 9,
              totalExecTime: 90,
              meanExecTime: 10,
              totalRows: 18,
            },
          ],
        };
      },
    };
    const adapter = new HistoricSqlSourceAdapter({
      sqlAnalysis,
      reader: unusedPerExecutionReader,
      queryClient: {},
      postgresReader,
      postgresQueryClient: {
        async executeQuery() {
          return { headers: [], rows: [] };
        },
      },
      postgresBaselineRootDir: baselineRootDir,
      now: () => new Date('2026-05-08T12:00:00.000Z'),
    });

    await adapter.fetch(
      {
        dialect: 'postgres',
        windowDays: 90,
        lastSuccessfulCursor: null,
        serviceAccountUserPatterns: [],
        redactionPatterns: [],
        maxTemplatesPerRun: 5000,
        minCalls: 5,
      },
      stagedDir,
      { connectionId: 'conn_pg', sourceKey: 'historic-sql' },
    );

    const manifest = JSON.parse(await readFile(join(stagedDir, 'manifest.json'), 'utf-8')) as {
      dialect: string;
      baselineFirstRun: boolean;
      templates: Array<{ id: string }>;
    };
    expect(manifest.dialect).toBe('postgres');
    expect(manifest.baselineFirstRun).toBe(true);
    expect(manifest.templates).toEqual([
      { id: 'db5_q901', fingerprint: 'fp_1', subClusterId: null, path: 'templates/db5_q901/page.md' },
    ]);
    await expect(readFile(baselinePath, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });

    await adapter.onPullSucceeded({
      connectionId: 'conn_pg',
      sourceKey: 'historic-sql',
      syncId: 'sync_pg',
      trigger: 'scheduled_pull',
      completedAt: new Date('2026-05-08T12:01:00.000Z'),
      stagedDir,
    });

    const baseline = JSON.parse(await readFile(baselinePath, 'utf-8')) as {
      fetchedAt: string;
      templates: Record<string, { perUser: Record<string, { calls: number }> }>;
    };
    expect(baseline.fetchedAt).toBe('2026-05-08T12:00:00.000Z');
    expect(baseline.templates.db5_q901.perUser['11'].calls).toBe(9);
  });

  it('fails postgres fetches clearly when no PGSS reader is configured', async () => {
    const adapter = new HistoricSqlSourceAdapter({ sqlAnalysis, reader, queryClient: {} });

    await expect(
      adapter.fetch(
        {
          dialect: 'postgres',
          windowDays: 90,
          lastSuccessfulCursor: null,
          serviceAccountUserPatterns: [],
          redactionPatterns: [],
          maxTemplatesPerRun: 5000,
          minCalls: 5,
        },
        await tempDir(),
        { connectionId: 'conn_pg', sourceKey: 'historic-sql' },
      ),
    ).rejects.toThrow('Historic SQL Postgres fetch requires deps.postgresReader');
  });

  it('forwards manifest cursor through onPullSucceeded without changing the SourceAdapter signature', async () => {
    const stagedDir = await tempDir();
    await writeJson(stagedDir, 'manifest.json', {
      source: 'historic-sql',
      connectionId: 'conn_1',
      dialect: 'snowflake',
      fetchedAt: '2026-05-04T12:00:00.000Z',
      windowStart: '2026-02-03T12:00:00.000Z',
      windowEnd: '2026-05-04T12:00:00.000Z',
      nextSuccessfulCursor: '2026-05-04T11:55:00.000Z',
      templateCount: 0,
      capped: false,
      warnings: [],
      templates: [],
    });
    const onPullSucceeded = vi.fn(async () => {});
    const adapter = new HistoricSqlSourceAdapter({ sqlAnalysis, reader, queryClient: {}, onPullSucceeded });
    const completedAt = new Date('2026-05-04T12:01:00.000Z');

    await adapter.onPullSucceeded({
      connectionId: 'conn_1',
      sourceKey: 'historic-sql',
      syncId: 'sync_1',
      trigger: 'scheduled_pull',
      completedAt,
      stagedDir,
    });

    expect(onPullSucceeded).toHaveBeenCalledWith({
      connectionId: 'conn_1',
      sourceKey: 'historic-sql',
      syncId: 'sync_1',
      trigger: 'scheduled_pull',
      completedAt,
      stagedDir,
      nextSuccessfulCursor: '2026-05-04T11:55:00.000Z',
    });
  });
});
