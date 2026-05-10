import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SqlAnalysisPort } from '../../../sql-analysis/index.js';
import {
  pgssBaselinePath,
  readPgssBaseline,
  stagePgStatStatementsTemplates,
  writePgssBaselineAtomic,
  type PgssBaseline,
} from './stage-pgss.js';
import { historicSqlManifestSchema, historicSqlMetadataSchema, historicSqlUsageSchema } from './types.js';
import type { KtxPostgresQueryClient, PostgresPgssReader, PostgresPgssRow } from './types.js';

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function readJson<T>(root: string, relPath: string): Promise<T> {
  return JSON.parse(await readFile(join(root, relPath), 'utf-8')) as T;
}

function fakePgClient(): KtxPostgresQueryClient {
  return {
    async executeQuery() {
      return { headers: [], rows: [] };
    },
  };
}

function row(overrides: Partial<PostgresPgssRow> & Pick<PostgresPgssRow, 'queryid' | 'query'>): PostgresPgssRow {
  return {
    userid: '11',
    username: 'analyst',
    dbid: '5',
    database: 'warehouse',
    calls: 10,
    totalExecTime: 250,
    meanExecTime: 25,
    totalRows: 20,
    ...overrides,
  };
}

function fakeReader(input: {
  pgServerVersion?: string;
  warnings?: string[];
  statsResetAt?: string | null;
  deallocCount?: number | null;
  rows: PostgresPgssRow[];
}): PostgresPgssReader {
  return {
    probe: vi.fn(async () => ({
      pgServerVersion: input.pgServerVersion ?? 'PostgreSQL 16.4',
      warnings: input.warnings ?? [],
    })),
    readSnapshot: vi.fn(async (_client, options) => ({
      statsResetAt: input.statsResetAt ?? '2026-05-08T08:00:00.000Z',
      deallocCount: input.deallocCount ?? 0,
      rows: input.rows.slice(0, options.maxTemplates),
    })),
  };
}

const sqlAnalysis: SqlAnalysisPort = {
  async analyzeForFingerprint(sql) {
    if (sql.includes('broken')) {
      return {
        fingerprint: '',
        normalizedSql: '',
        tablesTouched: [],
        literalSlots: [],
        error: 'parse failed',
      };
    }
    if (sql.includes('customers')) {
      return {
        fingerprint: 'fp_customers',
        normalizedSql: 'SELECT count(*) FROM analytics.customers',
        tablesTouched: ['analytics.customers'],
        literalSlots: [],
      };
    }
    return {
      fingerprint: 'fp_orders',
      normalizedSql: 'SELECT count(*) FROM analytics.orders WHERE status = $1',
      tablesTouched: ['analytics.orders'],
      literalSlots: [],
    };
  },
};

function postgresPullConfig(maxTemplatesPerRun = 5000) {
  return {
    dialect: 'postgres' as const,
    windowDays: 90,
    lastSuccessfulCursor: null,
    serviceAccountUserPatterns: ['^svc_'],
    redactionPatterns: ['secret'],
    maxTemplatesPerRun,
    minCalls: 5,
  };
}

describe('stagePgStatStatementsTemplates', () => {
  it('stages first-run PGSS templates as degraded aggregate templates and builds a next baseline', async () => {
    const stagedDir = await tempDir('pgss-stage-first-');
    const baselineRootDir = await tempDir('pgss-baseline-first-');
    const baselinePath = pgssBaselinePath(baselineRootDir, 'conn_pg');

    const result = await stagePgStatStatementsTemplates({
      stagedDir,
      connectionId: 'conn_pg',
      queryClient: fakePgClient(),
      reader: fakeReader({
        warnings: ['pg_stat_statements.track is none; set it to top or all in the Postgres parameter group or config'],
        deallocCount: 2,
        rows: [
          row({
            queryid: '101',
            query: 'SELECT count(*) FROM analytics.orders WHERE status = $1',
            calls: 10,
            totalExecTime: 250,
            totalRows: 20,
          }),
          row({
            queryid: '102',
            query: 'SELECT * FROM pg_catalog.pg_class',
            calls: 50,
            totalExecTime: 500,
          }),
          row({
            queryid: '103',
            query: 'BEGIN',
            calls: 75,
            totalExecTime: 75,
          }),
          row({
            queryid: '104',
            query: 'SELECT broken FROM analytics.orders',
            calls: 8,
            totalExecTime: 80,
          }),
        ],
      }),
      sqlAnalysis,
      pullConfig: postgresPullConfig(),
      baselinePath,
      now: new Date('2026-05-08T12:00:00.000Z'),
    });

    const manifest = historicSqlManifestSchema.parse(await readJson(stagedDir, 'manifest.json'));
    expect(manifest).toMatchObject({
      source: 'historic-sql',
      connectionId: 'conn_pg',
      dialect: 'postgres',
      fetchedAt: '2026-05-08T12:00:00.000Z',
      windowEnd: '2026-05-08T12:00:00.000Z',
      nextSuccessfulCursor: '2026-05-08T12:00:00.000Z',
      templateCount: 1,
      capped: false,
      degraded: true,
      statsResetAt: '2026-05-08T08:00:00.000Z',
      baselineFirstRun: true,
      pgServerVersion: 'PostgreSQL 16.4',
      deallocCount: 2,
    });
    expect(manifest.warnings).toEqual([
      'pg_stat_statements.track is none; set it to top or all in the Postgres parameter group or config',
      'pgss_dealloc_count:2; pg_stat_statements.max may be too low, causing template eviction churn',
      'baseline_first_run:no_previous_pgss_baseline',
      'analysis_failed:db5_q104',
    ]);
    expect(manifest.templates).toEqual([
      {
        id: 'db5_q101',
        fingerprint: 'fp_orders',
        subClusterId: null,
        path: 'templates/db5_q101/page.md',
      },
    ]);

    const metadata = historicSqlMetadataSchema.parse(await readJson(stagedDir, 'templates/db5_q101/metadata.json'));
    expect(metadata).toMatchObject({
      id: 'db5_q101',
      title: 'postgres · analytics.orders [db5_q101]',
      path: 'templates/db5_q101/page.md',
      objectType: 'historic_sql_template',
      lastEditedAt: null,
      properties: {
        fingerprint: 'fp_orders',
        sub_cluster_id: null,
        dialect: 'postgres',
        tables_touched: ['analytics.orders'],
        literal_slots: [],
      },
    });
    expect(metadata.properties.triage_signals).toEqual({
      executions_bucket: 'mid',
      distinct_users_bucket: 'solo',
      error_rate_bucket: 'ok',
      recency_bucket: 'active',
      service_account_only: 'false',
      runtime_bucket: 'fast',
    });

    const usage = historicSqlUsageSchema.parse(await readJson(stagedDir, 'templates/db5_q101/usage.json'));
    expect(usage).toEqual({
      stats: {
        executions: 10,
        distinct_users: 1,
        first_seen: '2026-05-08T12:00:00.000Z',
        last_seen: '2026-05-08T12:00:00.000Z',
        p50_runtime_ms: null,
        p95_runtime_ms: null,
        mean_runtime_ms: 25,
        error_rate: 0,
        rows_produced: 20,
      },
      literal_slots: [],
      samples: [],
    });

    expect(await readFile(join(stagedDir, 'templates/db5_q101/page.md'), 'utf-8')).toContain(
      'SELECT count(*) FROM analytics.orders WHERE status = $1',
    );
    expect(result.baselinePath).toBe(baselinePath);
    expect(result.baseline.templates.db5_q101.perUser['11']).toEqual({
      calls: 10,
      totalExecTime: 250,
      totalRows: 20,
    });
    await expect(readPgssBaseline(baselinePath)).resolves.toBeNull();
  });

  it('warns when pg_stat_statements reports dealloc churn', async () => {
    const root = await tempDir('pgss-churn-');
    const stagedDir = join(root, 'staged');
    const baselinePath = join(root, 'cache', 'warehouse', 'pgss-baseline.json');

    await stagePgStatStatementsTemplates({
      stagedDir,
      connectionId: 'warehouse',
      queryClient: fakePgClient(),
      reader: fakeReader({
        rows: [
          row({
            queryid: '901',
            query: 'SELECT COUNT(*) FROM public.orders WHERE status = $1',
            calls: 20,
            totalExecTime: 500,
            meanExecTime: 25,
          }),
        ],
        deallocCount: 3,
      }),
      sqlAnalysis,
      pullConfig: postgresPullConfig(50),
      baselinePath,
      now: new Date('2026-05-08T12:00:00.000Z'),
    });

    const manifest = await readJson<{ warnings: string[]; deallocCount: number }>(stagedDir, 'manifest.json');
    expect(manifest.deallocCount).toBe(3);
    expect(manifest.warnings).toContain(
      'pgss_dealloc_count:3; pg_stat_statements.max may be too low, causing template eviction churn',
    );
  });

  it('uses the saved cumulative baseline to stage only positive deltas on later runs', async () => {
    const stagedDir = await tempDir('pgss-stage-delta-');
    const baselineRootDir = await tempDir('pgss-baseline-delta-');
    const baselinePath = pgssBaselinePath(baselineRootDir, 'conn_pg');
    const baseline: PgssBaseline = {
      version: 1,
      fetchedAt: '2026-05-08T10:00:00.000Z',
      statsResetAt: '2026-05-08T08:00:00.000Z',
      pgServerVersion: 'PostgreSQL 16.4',
      templates: {
        db5_q201: {
          firstObservedAt: '2026-05-08T09:00:00.000Z',
          perUser: {
            '11': { calls: 10, totalExecTime: 100, totalRows: 50 },
            '12': { calls: 5, totalExecTime: 50, totalRows: 25 },
          },
        },
      },
    };
    await writePgssBaselineAtomic(baselinePath, baseline);

    await stagePgStatStatementsTemplates({
      stagedDir,
      connectionId: 'conn_pg',
      queryClient: fakePgClient(),
      reader: fakeReader({
        rows: [
          row({
            queryid: '201',
            userid: '11',
            username: 'analyst',
            query: 'SELECT count(*) FROM analytics.orders WHERE status = $1',
            calls: 12,
            totalExecTime: 160,
            totalRows: 58,
          }),
          row({
            queryid: '201',
            userid: '12',
            username: 'svc_loader',
            query: 'SELECT count(*) FROM analytics.orders WHERE status = $1',
            calls: 5,
            totalExecTime: 50,
            totalRows: 25,
          }),
          row({
            queryid: '202',
            userid: '13',
            username: 'analyst_2',
            query: 'SELECT count(*) FROM analytics.customers',
            calls: 7,
            totalExecTime: 210,
            totalRows: 7,
          }),
        ],
      }),
      sqlAnalysis,
      pullConfig: postgresPullConfig(),
      baselinePath,
      now: new Date('2026-05-08T12:00:00.000Z'),
    });

    const manifest = historicSqlManifestSchema.parse(await readJson(stagedDir, 'manifest.json'));
    expect(manifest.baselineFirstRun).toBe(false);
    expect(manifest.windowStart).toBe('2026-05-08T10:00:00.000Z');
    expect(manifest.templateCount).toBe(2);
    expect(manifest.templates.map((template) => template.id)).toEqual(['db5_q202', 'db5_q201']);

    const usage201 = historicSqlUsageSchema.parse(await readJson(stagedDir, 'templates/db5_q201/usage.json'));
    expect(usage201.stats).toMatchObject({
      executions: 2,
      distinct_users: 1,
      first_seen: '2026-05-08T09:00:00.000Z',
      last_seen: '2026-05-08T12:00:00.000Z',
      mean_runtime_ms: 30,
      rows_produced: 8,
    });
    const metadata201 = historicSqlMetadataSchema.parse(await readJson(stagedDir, 'templates/db5_q201/metadata.json'));
    expect(metadata201.properties.triage_signals.service_account_only).toBe('false');

    const usage202 = historicSqlUsageSchema.parse(await readJson(stagedDir, 'templates/db5_q202/usage.json'));
    expect(usage202.stats).toMatchObject({
      executions: 7,
      distinct_users: 1,
      first_seen: '2026-05-08T12:00:00.000Z',
      mean_runtime_ms: 30,
      rows_produced: 7,
    });
  });

  it('keeps matching queryid values from different databases as distinct templates and baseline entries', async () => {
    const stagedDir = await tempDir('pgss-stage-db-key-');
    const baselineRootDir = await tempDir('pgss-baseline-db-key-');
    const baselinePath = pgssBaselinePath(baselineRootDir, 'conn_pg');
    await writePgssBaselineAtomic(baselinePath, {
      version: 1,
      fetchedAt: '2026-05-08T10:00:00.000Z',
      statsResetAt: '2026-05-08T08:00:00.000Z',
      pgServerVersion: 'PostgreSQL 16.4',
      templates: {
        db5_q701: {
          firstObservedAt: '2026-05-08T09:00:00.000Z',
          perUser: {
            '11': { calls: 10, totalExecTime: 100, totalRows: 50 },
          },
        },
        db6_q701: {
          firstObservedAt: '2026-05-08T09:30:00.000Z',
          perUser: {
            '11': { calls: 4, totalExecTime: 40, totalRows: 20 },
          },
        },
      },
    });

    const result = await stagePgStatStatementsTemplates({
      stagedDir,
      connectionId: 'conn_pg',
      queryClient: fakePgClient(),
      reader: fakeReader({
        rows: [
          row({
            queryid: '701',
            dbid: '5',
            database: 'warehouse',
            query: 'SELECT count(*) FROM analytics.orders WHERE status = $1',
            calls: 12,
            totalExecTime: 160,
            totalRows: 58,
          }),
          row({
            queryid: '701',
            dbid: '6',
            database: 'app',
            query: 'SELECT count(*) FROM analytics.orders WHERE status = $1',
            calls: 9,
            totalExecTime: 130,
            totalRows: 35,
          }),
        ],
      }),
      sqlAnalysis,
      pullConfig: postgresPullConfig(),
      baselinePath,
      now: new Date('2026-05-08T12:00:00.000Z'),
    });

    const manifest = historicSqlManifestSchema.parse(await readJson(stagedDir, 'manifest.json'));
    expect(manifest.templates.map((template) => template.id).sort()).toEqual(['db5_q701', 'db6_q701']);

    const warehouseUsage = historicSqlUsageSchema.parse(await readJson(stagedDir, 'templates/db5_q701/usage.json'));
    expect(warehouseUsage.stats).toMatchObject({
      executions: 2,
      rows_produced: 8,
      first_seen: '2026-05-08T09:00:00.000Z',
    });

    const appUsage = historicSqlUsageSchema.parse(await readJson(stagedDir, 'templates/db6_q701/usage.json'));
    expect(appUsage.stats).toMatchObject({
      executions: 5,
      rows_produced: 15,
      first_seen: '2026-05-08T09:30:00.000Z',
    });

    expect(result.baseline.templates.db5_q701.perUser['11']).toEqual({
      calls: 12,
      totalExecTime: 160,
      totalRows: 58,
    });
    expect(result.baseline.templates.db6_q701.perUser['11']).toEqual({
      calls: 9,
      totalExecTime: 130,
      totalRows: 35,
    });
  });

  it('treats stats_reset advancement and major-version changes as fresh baselines', async () => {
    const resetStagedDir = await tempDir('pgss-stage-reset-');
    const resetBaselineRootDir = await tempDir('pgss-baseline-reset-');
    const resetBaselinePath = pgssBaselinePath(resetBaselineRootDir, 'conn_pg');
    await writePgssBaselineAtomic(resetBaselinePath, {
      version: 1,
      fetchedAt: '2026-05-08T10:00:00.000Z',
      statsResetAt: '2026-05-08T08:00:00.000Z',
      pgServerVersion: 'PostgreSQL 16.4',
      templates: {
        db5_q301: {
          firstObservedAt: '2026-05-08T09:00:00.000Z',
          perUser: {
            '11': { calls: 100, totalExecTime: 1000, totalRows: 500 },
          },
        },
      },
    });

    await stagePgStatStatementsTemplates({
      stagedDir: resetStagedDir,
      connectionId: 'conn_pg',
      queryClient: fakePgClient(),
      reader: fakeReader({
        statsResetAt: '2026-05-08T11:00:00.000Z',
        rows: [
          row({
            queryid: '301',
            query: 'SELECT count(*) FROM analytics.orders WHERE status = $1',
            calls: 3,
            totalExecTime: 90,
            totalRows: 9,
          }),
        ],
      }),
      sqlAnalysis,
      pullConfig: postgresPullConfig(),
      baselinePath: resetBaselinePath,
      now: new Date('2026-05-08T12:00:00.000Z'),
    });

    const resetManifest = historicSqlManifestSchema.parse(await readJson(resetStagedDir, 'manifest.json'));
    expect(resetManifest.baselineFirstRun).toBe(true);
    expect(resetManifest.warnings).toContain(
      'baseline_reset:stats_reset advanced from 2026-05-08T08:00:00.000Z to 2026-05-08T11:00:00.000Z',
    );
    const resetUsage = historicSqlUsageSchema.parse(await readJson(resetStagedDir, 'templates/db5_q301/usage.json'));
    expect(resetUsage.stats.executions).toBe(3);

    const versionStagedDir = await tempDir('pgss-stage-version-');
    const versionBaselineRootDir = await tempDir('pgss-baseline-version-');
    const versionBaselinePath = pgssBaselinePath(versionBaselineRootDir, 'conn_pg');
    await writePgssBaselineAtomic(versionBaselinePath, {
      version: 1,
      fetchedAt: '2026-05-08T10:00:00.000Z',
      statsResetAt: '2026-05-08T08:00:00.000Z',
      pgServerVersion: 'PostgreSQL 15.7',
      templates: {
        db5_q302: {
          firstObservedAt: '2026-05-08T09:00:00.000Z',
          perUser: {
            '11': { calls: 100, totalExecTime: 1000, totalRows: 500 },
          },
        },
      },
    });

    await stagePgStatStatementsTemplates({
      stagedDir: versionStagedDir,
      connectionId: 'conn_pg',
      queryClient: fakePgClient(),
      reader: fakeReader({
        pgServerVersion: 'PostgreSQL 16.4',
        rows: [
          row({
            queryid: '302',
            query: 'SELECT count(*) FROM analytics.orders WHERE status = $1',
            calls: 4,
            totalExecTime: 80,
            totalRows: 8,
          }),
        ],
      }),
      sqlAnalysis,
      pullConfig: postgresPullConfig(),
      baselinePath: versionBaselinePath,
      now: new Date('2026-05-08T12:00:00.000Z'),
    });

    const versionManifest = historicSqlManifestSchema.parse(await readJson(versionStagedDir, 'manifest.json'));
    expect(versionManifest.baselineFirstRun).toBe(true);
    expect(versionManifest.warnings).toContain('baseline_reset:pg_server_major changed from 15 to 16');
  });

  it('handles scoped counter regressions without forcing a global first-run baseline', async () => {
    const stagedDir = await tempDir('pgss-stage-scoped-');
    const baselineRootDir = await tempDir('pgss-baseline-scoped-');
    const baselinePath = pgssBaselinePath(baselineRootDir, 'conn_pg');
    await writePgssBaselineAtomic(baselinePath, {
      version: 1,
      fetchedAt: '2026-05-08T10:00:00.000Z',
      statsResetAt: '2026-05-08T08:00:00.000Z',
      pgServerVersion: 'PostgreSQL 16.4',
      templates: {
        db5_q401: {
          firstObservedAt: '2026-05-08T09:00:00.000Z',
          perUser: {
            '11': { calls: 100, totalExecTime: 1000, totalRows: 500 },
            '12': { calls: 50, totalExecTime: 500, totalRows: 250 },
          },
        },
      },
    });

    await stagePgStatStatementsTemplates({
      stagedDir,
      connectionId: 'conn_pg',
      queryClient: fakePgClient(),
      reader: fakeReader({
        statsResetAt: '2026-05-08T08:00:00.000Z',
        rows: [
          row({
            queryid: '401',
            userid: '11',
            username: 'analyst',
            query: 'SELECT count(*) FROM analytics.orders WHERE status = $1',
            calls: 2,
            totalExecTime: 30,
            totalRows: 6,
          }),
          row({
            queryid: '401',
            userid: '12',
            username: 'svc_loader',
            query: 'SELECT count(*) FROM analytics.orders WHERE status = $1',
            calls: 55,
            totalExecTime: 650,
            totalRows: 275,
          }),
        ],
      }),
      sqlAnalysis,
      pullConfig: postgresPullConfig(),
      baselinePath,
      now: new Date('2026-05-08T12:00:00.000Z'),
    });

    const manifest = historicSqlManifestSchema.parse(await readJson(stagedDir, 'manifest.json'));
    expect(manifest.baselineFirstRun).toBe(false);
    expect(manifest.warnings).toContain('scoped_reset:dbid=5 queryid=401 userid=11');

    const usage = historicSqlUsageSchema.parse(await readJson(stagedDir, 'templates/db5_q401/usage.json'));
    expect(usage.stats).toMatchObject({
      executions: 7,
      distinct_users: 2,
      mean_runtime_ms: 25.714285714285715,
      rows_produced: 31,
    });
  });

  it('ranks and caps selected PGSS templates after skip and analysis filtering', async () => {
    const stagedDir = await tempDir('pgss-stage-cap-');
    const baselineRootDir = await tempDir('pgss-baseline-cap-');
    const baselinePath = pgssBaselinePath(baselineRootDir, 'conn_pg');

    await stagePgStatStatementsTemplates({
      stagedDir,
      connectionId: 'conn_pg',
      queryClient: fakePgClient(),
      reader: fakeReader({
        rows: [
          row({
            queryid: '501',
            username: 'analyst_a',
            query: 'SELECT count(*) FROM analytics.orders WHERE status = $1',
            calls: 2,
            totalExecTime: 20,
          }),
          row({
            queryid: '502',
            username: 'analyst_b',
            query: 'SELECT count(*) FROM analytics.customers',
            calls: 20,
            totalExecTime: 200,
          }),
          row({
            queryid: '503',
            username: 'analyst_c',
            query: 'SELECT count(*) FROM analytics.orders WHERE status = $1',
            calls: 10,
            totalExecTime: 100,
          }),
        ],
      }),
      sqlAnalysis,
      pullConfig: postgresPullConfig(2),
      baselinePath,
      now: new Date('2026-05-08T12:00:00.000Z'),
    });

    const manifest = historicSqlManifestSchema.parse(await readJson(stagedDir, 'manifest.json'));
    expect(manifest.capped).toBe(true);
    expect(manifest.warnings).toContain('templates_truncated: kept 2 of 3 templates');
    expect(manifest.templates.map((template) => template.id)).toEqual(['db5_q502', 'db5_q503']);
  });
});
