import { z } from 'zod';
import type { SqlAnalysisPort } from '../../../sql-analysis/index.js';

export const HISTORIC_SQL_SOURCE_KEY = 'historic-sql' as const;
export const HISTORIC_SQL_OBJECT_TYPE = 'historic_sql_template' as const;

const historicSqlDialectSchema = z.enum(['snowflake', 'bigquery', 'postgres']);
export type HistoricSqlDialect = z.infer<typeof historicSqlDialectSchema>;

export const historicSqlPullConfigSchema = z.object({
  dialect: historicSqlDialectSchema,
  windowDays: z.number().int().min(1).max(365).default(90),
  lastSuccessfulCursor: z.string().datetime().nullable().default(null),
  serviceAccountUserPatterns: z.array(z.string()).default([]),
  redactionPatterns: z.array(z.string()).default([]),
  maxTemplatesPerRun: z.number().int().min(1).max(5000).default(5000),
  minCalls: z.number().int().min(1).default(5),
});
export type HistoricSqlPullConfig = z.infer<typeof historicSqlPullConfigSchema>;

export interface HistoricSqlTimeWindow {
  start: Date;
  end: Date;
}

export const historicSqlRawQueryRowSchema = z.object({
  id: z.string().min(1),
  sql: z.string().min(1),
  user: z.string().nullable().default(null),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable().default(null),
  runtimeMs: z.number().nonnegative().nullable().default(null),
  rowsProduced: z.number().int().nonnegative().nullable().optional(),
  success: z.boolean().default(true),
  errorMessage: z.string().nullable().default(null),
});
export type HistoricSqlRawQueryRow = z.infer<typeof historicSqlRawQueryRowSchema>;

export interface HistoricSqlQueryHistoryReader {
  probe(client: unknown): Promise<void>;
  fetch(
    client: unknown,
    window: HistoricSqlTimeWindow,
    cursor?: string | null,
  ): AsyncIterable<HistoricSqlRawQueryRow>;
}

export interface KtxPostgresQueryClient {
  executeQuery(sql: string, params?: unknown[]): Promise<{ headers: string[]; rows: unknown[][]; totalRows?: number }>;
}

export interface PostgresPgssProbeResult {
  pgServerVersion: string;
  warnings: string[];
}

export interface PostgresPgssSnapshot {
  statsResetAt: string | null;
  deallocCount: number | null;
  rows: PostgresPgssRow[];
}

export interface PostgresPgssReader {
  probe(client: KtxPostgresQueryClient): Promise<PostgresPgssProbeResult>;
  readSnapshot(
    client: KtxPostgresQueryClient,
    options: { minCalls: number; maxTemplates: number },
  ): Promise<PostgresPgssSnapshot>;
}

export interface PostgresPgssRow {
  queryid: string;
  userid: string;
  username: string | null;
  dbid: string;
  database: string | null;
  query: string;
  calls: number;
  totalExecTime: number;
  meanExecTime: number;
  totalRows: number;
}

export interface PostgresPgssAggregateRow {
  id: string;
  queryid: string;
  dbid: string;
  database: string | null;
  query: string;
  deltaCalls: number;
  deltaExecTime: number;
  deltaRows: number;
  meanExecTime: number;
  distinctUsersDelta: number;
  users: string[];
  firstObservedAt: string;
}

export interface HistoricSqlSourceAdapterDeps {
  sqlAnalysis: SqlAnalysisPort;
  reader: HistoricSqlQueryHistoryReader;
  queryClient: unknown;
  postgresReader?: PostgresPgssReader;
  postgresQueryClient?: KtxPostgresQueryClient;
  postgresBaselineRootDir?: string;
  now?: () => Date;
  onPullSucceeded?: (ctx: {
    connectionId: string;
    sourceKey: string;
    syncId: string;
    trigger: import('../../types.js').IngestTrigger;
    completedAt: Date;
    stagedDir: string;
    nextSuccessfulCursor: string | null;
  }) => Promise<void>;
}

const historicSqlLiteralSlotClassificationSchema = z.enum(['constant', 'runtime', 'categorical']);
export type HistoricSqlLiteralSlotClassification = z.infer<typeof historicSqlLiteralSlotClassificationSchema>;

export const historicSqlMetadataSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  path: z.string().min(1),
  objectType: z.literal(HISTORIC_SQL_OBJECT_TYPE),
  lastEditedAt: z.null(),
  properties: z.object({
    fingerprint: z.string().min(1),
    sub_cluster_id: z.string().nullable(),
    dialect: historicSqlDialectSchema,
    tables_touched: z.array(z.string()),
    literal_slots: z.array(
      z.object({
        position: z.number().int().min(1),
        type: z.enum(['string', 'number', 'timestamp', 'date', 'boolean', 'null', 'unknown']),
        classification: historicSqlLiteralSlotClassificationSchema,
      }),
    ),
    triage_signals: z.record(z.string(), z.string()),
  }),
});
export type HistoricSqlMetadata = z.infer<typeof historicSqlMetadataSchema>;

export const historicSqlUsageSchema = z.object({
  stats: z.object({
    executions: z.number().int().nonnegative(),
    distinct_users: z.number().int().nonnegative(),
    first_seen: z.string().datetime(),
    last_seen: z.string().datetime(),
    p50_runtime_ms: z.number().nonnegative().nullable(),
    p95_runtime_ms: z.number().nonnegative().nullable(),
    mean_runtime_ms: z.number().nonnegative().nullable().optional(),
    error_rate: z.number().min(0).max(1),
    rows_produced: z.number().int().nonnegative().nullable().optional(),
  }),
  literal_slots: z.array(
    z.object({
      position: z.number().int().min(1),
      distinct_values: z.number().int().nonnegative(),
      top_values: z.array(z.tuple([z.string(), z.number().int().nonnegative()])),
    }),
  ),
  samples: z.array(
    z.object({
      started_at: z.string().datetime(),
      user: z.string().nullable(),
      bound_sql: z.string(),
      rows_produced: z.number().int().nonnegative().nullable().optional(),
      runtime_ms: z.number().nonnegative().nullable(),
      success: z.boolean(),
    }),
  ),
});
export type HistoricSqlUsage = z.infer<typeof historicSqlUsageSchema>;

export const historicSqlManifestSchema = z.object({
  source: z.literal(HISTORIC_SQL_SOURCE_KEY),
  connectionId: z.string().min(1),
  dialect: historicSqlDialectSchema,
  fetchedAt: z.string().datetime(),
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
  nextSuccessfulCursor: z.string().datetime().nullable(),
  templateCount: z.number().int().nonnegative(),
  capped: z.boolean(),
  warnings: z.array(z.string()),
  degraded: z.boolean().default(false),
  statsResetAt: z.string().datetime().nullable().default(null),
  baselineFirstRun: z.boolean().default(false),
  pgServerVersion: z.string().nullable().default(null),
  deallocCount: z.number().int().nonnegative().nullable().default(null),
  templates: z.array(
    z.object({
      id: z.string().min(1),
      fingerprint: z.string().min(1),
      subClusterId: z.string().nullable(),
      path: z.string().min(1),
    }),
  ),
});
export type HistoricSqlManifest = z.infer<typeof historicSqlManifestSchema>;
