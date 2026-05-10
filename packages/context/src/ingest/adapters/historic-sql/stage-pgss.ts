import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { SqlAnalysisFingerprintResult, SqlAnalysisPort } from '../../../sql-analysis/index.js';
import {
  HISTORIC_SQL_OBJECT_TYPE,
  HISTORIC_SQL_SOURCE_KEY,
  historicSqlPullConfigSchema,
  type HistoricSqlManifest,
  type HistoricSqlMetadata,
  type HistoricSqlPullConfig,
  type HistoricSqlUsage,
  type KtxPostgresQueryClient,
  type PostgresPgssAggregateRow,
  type PostgresPgssReader,
  type PostgresPgssRow,
} from './types.js';

const PGSS_BASELINE_VERSION = 1 as const;

const pgssCounterSchema = z.object({
  calls: z.number().int().nonnegative(),
  totalExecTime: z.number().nonnegative(),
  totalRows: z.number().int().nonnegative(),
});

const pgssBaselineSchema = z.object({
  version: z.literal(PGSS_BASELINE_VERSION),
  fetchedAt: z.string().datetime(),
  statsResetAt: z.string().datetime().nullable(),
  pgServerVersion: z.string(),
  templates: z.record(
    z.string(),
    z.object({
      firstObservedAt: z.string().datetime(),
      perUser: z.record(z.string(), pgssCounterSchema),
    }),
  ),
});

export type PgssBaseline = z.infer<typeof pgssBaselineSchema>;

export interface StagePgStatStatementsTemplatesInput {
  stagedDir: string;
  connectionId: string;
  queryClient: KtxPostgresQueryClient;
  reader: PostgresPgssReader;
  sqlAnalysis: SqlAnalysisPort;
  pullConfig: HistoricSqlPullConfig;
  baselinePath: string;
  now?: Date;
}

export interface StagePgStatStatementsTemplatesResult {
  baselinePath: string;
  baseline: PgssBaseline;
}

interface PgssBaselineCounter {
  calls: number;
  totalExecTime: number;
  totalRows: number;
}

interface PgssAggregateMutable {
  id: string;
  queryid: string;
  dbid: string;
  database: string | null;
  query: string;
  deltaCalls: number;
  deltaExecTime: number;
  deltaRows: number;
  users: Set<string>;
  firstObservedAt: string;
}

interface AnalyzedPgssTemplate {
  aggregate: PostgresPgssAggregateRow;
  analysis: SqlAnalysisFingerprintResult;
}

const ZERO_COUNTER: PgssBaselineCounter = {
  calls: 0,
  totalExecTime: 0,
  totalRows: 0,
};

const PGSS_SNAPSHOT_READ_LIMIT = 5000;
const PGSS_HARD_SKIP_PREFIX_RE = /^\s*(SHOW|DESCRIBE|DESC|EXPLAIN|USE|SET|BEGIN|COMMIT|ROLLBACK|VACUUM|ANALYZE)\b/i;
const PGSS_HARD_SKIP_TABLE_RE = /\b(INFORMATION_SCHEMA|pg_catalog\.|pg_toast\.|pg_stat_)/i;

function pgssTemplateId(row: Pick<PostgresPgssRow, 'dbid' | 'queryid'>): string {
  return `db${row.dbid}_q${row.queryid}`;
}

export function pgssBaselinePath(rootDir: string | undefined, connectionId: string): string {
  return join(rootDir ?? join(process.cwd(), '.ktx/cache/historic-sql'), connectionId, 'pgss-baseline.json');
}

export async function readPgssBaseline(path: string): Promise<PgssBaseline | null> {
  try {
    return pgssBaselineSchema.parse(JSON.parse(await readFile(path, 'utf-8')));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function writePgssBaselineAtomic(path: string, baseline: PgssBaseline): Promise<void> {
  const parsed = pgssBaselineSchema.parse(baseline);
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');
  await rename(tempPath, path);
}

export async function stagePgStatStatementsTemplates(
  input: StagePgStatStatementsTemplatesInput,
): Promise<StagePgStatStatementsTemplatesResult> {
  const config = historicSqlPullConfigSchema.parse(input.pullConfig);
  if (config.dialect !== 'postgres') {
    throw new Error(`stagePgStatStatementsTemplates requires dialect postgres, got ${config.dialect}`);
  }

  const now = input.now ?? new Date();
  const fetchedAt = now.toISOString();
  const probe = await input.reader.probe(input.queryClient);
  const warnings = [...probe.warnings];
  const baseline = await readPgssBaseline(input.baselinePath);
  const snapshot = await input.reader.readSnapshot(input.queryClient, {
    minCalls: config.minCalls,
    maxTemplates: PGSS_SNAPSHOT_READ_LIMIT,
  });
  if (snapshot.deallocCount !== null && snapshot.deallocCount > 0) {
    warnings.push(
      `pgss_dealloc_count:${snapshot.deallocCount}; pg_stat_statements.max may be too low, causing template eviction churn`,
    );
  }
  const reset = detectBaselineReset({
    baseline,
    snapshotStatsResetAt: snapshot.statsResetAt,
    currentPgServerVersion: probe.pgServerVersion,
  });
  warnings.push(...reset.warnings);

  const aggregates = aggregatePgssRows({
    rows: snapshot.rows,
    baseline,
    baselineFirstRun: reset.baselineFirstRun,
    fetchedAt,
    warnings,
  }).filter((aggregate) => !shouldSkipPgssSql(aggregate.query));

  const analyzed: AnalyzedPgssTemplate[] = [];
  for (const aggregate of aggregates) {
    const analysis = await input.sqlAnalysis.analyzeForFingerprint(aggregate.query, 'postgres');
    if (analysis.error || !analysis.fingerprint || !analysis.normalizedSql) {
      warnings.push(`analysis_failed:${aggregate.id}`);
      continue;
    }
    analyzed.push({ aggregate, analysis });
  }

  const selected = selectPgssTemplates(analyzed, config.maxTemplatesPerRun);
  if (selected.length < analyzed.length) {
    warnings.push(`templates_truncated: kept ${selected.length} of ${analyzed.length} templates`);
  }

  await mkdir(input.stagedDir, { recursive: true });
  const templates: HistoricSqlManifest['templates'] = [];
  for (const template of selected) {
    const staged = buildPgssStagedTemplate(template, config, now);
    const basePath = `templates/${staged.metadata.id}`;
    await writeJson(input.stagedDir, `${basePath}/metadata.json`, staged.metadata);
    await writeText(input.stagedDir, `${basePath}/page.md`, staged.pageMarkdown);
    await writeJson(input.stagedDir, `${basePath}/usage.json`, staged.usage);
    templates.push({
      id: staged.metadata.id,
      fingerprint: staged.metadata.properties.fingerprint,
      subClusterId: staged.metadata.properties.sub_cluster_id,
      path: staged.metadata.path,
    });
  }

  await writeJson(input.stagedDir, 'manifest.json', {
    source: HISTORIC_SQL_SOURCE_KEY,
    connectionId: input.connectionId,
    dialect: 'postgres',
    fetchedAt,
    windowStart: baseline?.fetchedAt ?? snapshot.statsResetAt ?? fetchedAt,
    windowEnd: fetchedAt,
    nextSuccessfulCursor: fetchedAt,
    templateCount: selected.length,
    capped: selected.length < analyzed.length,
    warnings,
    degraded: true,
    statsResetAt: snapshot.statsResetAt,
    baselineFirstRun: reset.baselineFirstRun,
    pgServerVersion: probe.pgServerVersion,
    deallocCount: snapshot.deallocCount,
    templates,
  } satisfies HistoricSqlManifest);

  return {
    baselinePath: input.baselinePath,
    baseline: buildNextBaseline({
      rows: snapshot.rows,
      fetchedAt,
      statsResetAt: snapshot.statsResetAt,
      pgServerVersion: probe.pgServerVersion,
      previousBaseline: reset.baselineFirstRun ? null : baseline,
    }),
  };
}

function detectBaselineReset(input: {
  baseline: PgssBaseline | null;
  snapshotStatsResetAt: string | null;
  currentPgServerVersion: string;
}): { baselineFirstRun: boolean; warnings: string[] } {
  if (!input.baseline) {
    return { baselineFirstRun: true, warnings: ['baseline_first_run:no_previous_pgss_baseline'] };
  }

  const warnings: string[] = [];
  if (
    input.baseline.statsResetAt &&
    input.snapshotStatsResetAt &&
    input.baseline.statsResetAt < input.snapshotStatsResetAt
  ) {
    warnings.push(
      `baseline_reset:stats_reset advanced from ${input.baseline.statsResetAt} to ${input.snapshotStatsResetAt}`,
    );
  }

  const previousMajor = postgresMajor(input.baseline.pgServerVersion);
  const currentMajor = postgresMajor(input.currentPgServerVersion);
  if (previousMajor && currentMajor && previousMajor !== currentMajor) {
    warnings.push(`baseline_reset:pg_server_major changed from ${previousMajor} to ${currentMajor}`);
  }

  return { baselineFirstRun: warnings.length > 0, warnings };
}

function postgresMajor(version: string): string | null {
  return version.match(/PostgreSQL\s+(\d+)/i)?.[1] ?? version.match(/^(\d+)(?:\.|$)/)?.[1] ?? null;
}

function aggregatePgssRows(input: {
  rows: PostgresPgssRow[];
  baseline: PgssBaseline | null;
  baselineFirstRun: boolean;
  fetchedAt: string;
  warnings: string[];
}): PostgresPgssAggregateRow[] {
  const aggregates = new Map<string, PgssAggregateMutable>();

  for (const row of input.rows) {
    const templateId = pgssTemplateId(row);
    const baselineTemplate = input.baselineFirstRun ? undefined : input.baseline?.templates[templateId];
    const baselineCounter = baselineTemplate?.perUser[row.userid];
    const previous = scopedCounterBaseline(row, baselineCounter, input.baselineFirstRun, input.warnings);
    const deltaCalls = row.calls - previous.calls;
    const deltaExecTime = row.totalExecTime - previous.totalExecTime;
    const deltaRows = row.totalRows - previous.totalRows;
    if (deltaCalls === 0 && !input.baselineFirstRun) {
      continue;
    }

    const existing =
      aggregates.get(templateId) ??
      ({
        id: templateId,
        queryid: row.queryid,
        dbid: row.dbid,
        database: row.database,
        query: row.query,
        deltaCalls: 0,
        deltaExecTime: 0,
        deltaRows: 0,
        users: new Set<string>(),
        firstObservedAt: baselineTemplate?.firstObservedAt ?? input.fetchedAt,
      } satisfies PgssAggregateMutable);

    existing.deltaCalls += Math.max(0, deltaCalls);
    existing.deltaExecTime += Math.max(0, deltaExecTime);
    existing.deltaRows += Math.max(0, deltaRows);
    if (deltaCalls > 0) {
      existing.users.add(row.username ?? 'unknown');
    }
    aggregates.set(templateId, existing);
  }

  return [...aggregates.values()]
    .filter((aggregate) => aggregate.deltaCalls > 0)
    .map((aggregate) => ({
      id: aggregate.id,
      queryid: aggregate.queryid,
      dbid: aggregate.dbid,
      database: aggregate.database,
      query: aggregate.query,
      deltaCalls: aggregate.deltaCalls,
      deltaExecTime: aggregate.deltaExecTime,
      deltaRows: aggregate.deltaRows,
      meanExecTime: aggregate.deltaExecTime / Math.max(aggregate.deltaCalls, 1),
      distinctUsersDelta: aggregate.users.size,
      users: [...aggregate.users].sort(),
      firstObservedAt: aggregate.firstObservedAt,
    }));
}

function scopedCounterBaseline(
  row: PostgresPgssRow,
  baselineCounter: PgssBaselineCounter | undefined,
  baselineFirstRun: boolean,
  warnings: string[],
): PgssBaselineCounter {
  if (!baselineCounter || baselineFirstRun) {
    return ZERO_COUNTER;
  }
  if (
    baselineCounter.calls > row.calls ||
    baselineCounter.totalExecTime > row.totalExecTime ||
    baselineCounter.totalRows > row.totalRows
  ) {
    warnings.push(`scoped_reset:dbid=${row.dbid} queryid=${row.queryid} userid=${row.userid}`);
    return ZERO_COUNTER;
  }
  return baselineCounter;
}

function shouldSkipPgssSql(sql: string): boolean {
  return PGSS_HARD_SKIP_PREFIX_RE.test(sql) || PGSS_HARD_SKIP_TABLE_RE.test(sql);
}

function selectPgssTemplates(templates: AnalyzedPgssTemplate[], maxTemplatesPerRun: number): AnalyzedPgssTemplate[] {
  return templates
    .map((template) => ({
      template,
      score: template.aggregate.users.length * Math.log1p(template.aggregate.deltaCalls),
    }))
    .sort(
      (left, right) => right.score - left.score || left.template.aggregate.id.localeCompare(right.template.aggregate.id),
    )
    .slice(0, maxTemplatesPerRun)
    .map((entry) => entry.template);
}

function buildPgssStagedTemplate(
  template: AnalyzedPgssTemplate,
  config: HistoricSqlPullConfig,
  now: Date,
): { metadata: HistoricSqlMetadata; pageMarkdown: string; usage: HistoricSqlUsage } {
  const tablesTouched = [...template.analysis.tablesTouched].sort();
  const firstTable = tablesTouched[0] ?? 'query';
  const id = template.aggregate.id;

  const metadata: HistoricSqlMetadata = {
    id,
    title: `postgres · ${firstTable} [${id.slice(0, 12)}]`,
    path: `templates/${id}/page.md`,
    objectType: HISTORIC_SQL_OBJECT_TYPE,
    lastEditedAt: null,
    properties: {
      fingerprint: template.analysis.fingerprint,
      sub_cluster_id: null,
      dialect: 'postgres',
      tables_touched: tablesTouched,
      literal_slots: [],
      triage_signals: buildPgssTriageSignals({
        executions: template.aggregate.deltaCalls,
        distinctUsers: template.aggregate.distinctUsersDelta,
        firstSeen: template.aggregate.firstObservedAt,
        lastSeen: now.toISOString(),
        meanRuntimeMs: template.aggregate.meanExecTime,
        serviceAccountOnly: isServiceAccountOnly(template.aggregate.users, config.serviceAccountUserPatterns),
        now,
      }),
    },
  };

  return {
    metadata,
    pageMarkdown: renderTemplatePage(id, template.analysis.normalizedSql, tablesTouched),
    usage: {
      stats: {
        executions: template.aggregate.deltaCalls,
        distinct_users: template.aggregate.distinctUsersDelta,
        first_seen: template.aggregate.firstObservedAt,
        last_seen: now.toISOString(),
        p50_runtime_ms: null,
        p95_runtime_ms: null,
        mean_runtime_ms: template.aggregate.meanExecTime,
        error_rate: 0,
        rows_produced: template.aggregate.deltaRows,
      },
      literal_slots: [],
      samples: [],
    },
  };
}

function buildPgssTriageSignals(input: {
  executions: number;
  distinctUsers: number;
  firstSeen: string;
  lastSeen: string;
  meanRuntimeMs: number;
  serviceAccountOnly: boolean;
  now: Date;
}): Record<string, string> {
  return {
    executions_bucket: input.executions < 3 ? 'low' : input.executions < 50 ? 'mid' : 'high',
    distinct_users_bucket: input.distinctUsers <= 1 ? 'solo' : input.distinctUsers <= 5 ? 'team' : 'broad',
    error_rate_bucket: 'ok',
    recency_bucket: recencyBucket(input.lastSeen, input.now),
    service_account_only: String(input.serviceAccountOnly),
    runtime_bucket: runtimeBucket(input.meanRuntimeMs),
  };
}

function runtimeBucket(meanRuntimeMs: number): string {
  if (meanRuntimeMs < 100) {
    return 'fast';
  }
  if (meanRuntimeMs < 1000) {
    return 'moderate';
  }
  return 'slow';
}

function recencyBucket(lastSeen: string, now: Date): string {
  const ageDays = Math.max(0, (now.getTime() - new Date(lastSeen).getTime()) / 86400000);
  if (ageDays <= 14) {
    return 'active';
  }
  if (ageDays <= 60) {
    return 'warm';
  }
  return 'cold';
}

function isServiceAccountOnly(users: string[], patterns: string[]): boolean {
  if (users.length === 0 || patterns.length === 0) {
    return false;
  }
  const regexes = patterns.map((pattern) => new RegExp(pattern));
  return users.every((user) => regexes.some((regex) => regex.test(user)));
}

function renderTemplatePage(id: string, normalizedSql: string, tablesTouched: string[]): string {
  return [
    `# ${id}`,
    '',
    '## Normalized SQL',
    '```sql',
    normalizedSql,
    '```',
    '',
    '## Tables touched',
    ...tablesTouched.map((table) => `- ${table}`),
    '',
  ].join('\n');
}

function buildNextBaseline(input: {
  rows: PostgresPgssRow[];
  fetchedAt: string;
  statsResetAt: string | null;
  pgServerVersion: string;
  previousBaseline: PgssBaseline | null;
}): PgssBaseline {
  const templates: PgssBaseline['templates'] = {};
  for (const row of input.rows) {
    const templateId = pgssTemplateId(row);
    const previous = input.previousBaseline?.templates[templateId];
    const template = templates[templateId] ?? {
      firstObservedAt: previous?.firstObservedAt ?? input.fetchedAt,
      perUser: {},
    };
    template.perUser[row.userid] = {
      calls: row.calls,
      totalExecTime: row.totalExecTime,
      totalRows: row.totalRows,
    };
    templates[templateId] = template;
  }
  return {
    version: PGSS_BASELINE_VERSION,
    fetchedAt: input.fetchedAt,
    statsResetAt: input.statsResetAt,
    pgServerVersion: input.pgServerVersion,
    templates,
  };
}

async function writeJson(root: string, relPath: string, value: unknown): Promise<void> {
  await writeText(root, relPath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(root: string, relPath: string, value: string): Promise<void> {
  const target = join(root, relPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, value, 'utf-8');
}
