import {
  HistoricSqlExtensionMissingError,
  HistoricSqlGrantsMissingError,
  HistoricSqlVersionUnsupportedError,
} from './errors.js';
import type {
  KtxPostgresQueryClient,
  PostgresPgssProbeResult,
  PostgresPgssReader,
  PostgresPgssRow,
  PostgresPgssSnapshot,
} from './types.js';

interface QueryResultLike {
  headers: string[];
  rows: unknown[][];
  totalRows?: number;
  error?: string;
}

const VERSION_SQL = `
SELECT current_setting('server_version_num')::int AS server_version_num,
       version()                                  AS server_version
`.trim();

const EXTENSION_PROBE_SQL = 'SELECT 1 FROM pg_stat_statements LIMIT 1';
const GRANTS_PROBE_SQL = "SELECT pg_has_role(current_user, 'pg_read_all_stats', 'USAGE') AS has_role";
const TRACKING_PROBE_SQL = "SELECT current_setting('pg_stat_statements.track') AS track";
const MAX_SETTING_PROBE_SQL = "SELECT current_setting('pg_stat_statements.max') AS max";
const RECOMMENDED_PGSS_MAX = 5000;
const STATS_INFO_SQL = 'SELECT stats_reset, dealloc FROM pg_stat_statements_info';

const SNAPSHOT_SQL = `
SELECT
  s.queryid::text                AS queryid,
  s.userid::text                 AS userid,
  COALESCE(r.rolname, 'unknown') AS username,
  s.dbid::text                   AS dbid,
  d.datname                      AS database,
  s.query,
  s.calls,
  s.total_exec_time,
  s.mean_exec_time,
  s.rows                         AS total_rows
FROM pg_stat_statements s
LEFT JOIN pg_roles     r ON s.userid = r.oid
LEFT JOIN pg_database  d ON s.dbid   = d.oid
WHERE s.toplevel = true
  AND s.calls >= $1
ORDER BY s.total_exec_time DESC
LIMIT $2
`.trim();

const POSTGRES_EXTENSION_REMEDIATION = [
  'Run CREATE EXTENSION pg_stat_statements; against the connection database.',
  "Ensure shared_preload_libraries includes 'pg_stat_statements' in the Postgres parameter group or config.",
].join(' ');

const POSTGRES_GRANTS_REMEDIATION = 'GRANT pg_read_all_stats TO <connection role>;';

function queryClient(client: unknown): KtxPostgresQueryClient {
  if (
    client &&
    typeof client === 'object' &&
    'executeQuery' in client &&
    typeof (client as { executeQuery?: unknown }).executeQuery === 'function'
  ) {
    return client as KtxPostgresQueryClient;
  }
  throw new Error('Historic SQL Postgres PGSS reader requires a query client with executeQuery(sql, params?)');
}

async function execute(client: KtxPostgresQueryClient, sql: string, params?: unknown[]): Promise<QueryResultLike> {
  const result = await client.executeQuery(sql, params);
  if ('error' in result && typeof result.error === 'string' && result.error.length > 0) {
    throw new Error(result.error);
  }
  return result;
}

function indexes(headers: string[]): Map<string, number> {
  const out = new Map<string, number>();
  headers.forEach((header, index) => out.set(header.toLowerCase(), index));
  return out;
}

function value(row: unknown[], headerIndexes: Map<string, number>, header: string): unknown {
  const index = headerIndexes.get(header.toLowerCase());
  return index === undefined ? null : row[index];
}

function nullableString(raw: unknown): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  const text = String(raw);
  return text.length > 0 ? text : null;
}

function requiredString(raw: unknown, field: string): string {
  const text = nullableString(raw);
  if (!text) {
    throw new Error(`Postgres pg_stat_statements row is missing ${field}`);
  }
  return text;
}

function requiredFiniteNumber(raw: unknown, field: string): number {
  const number = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(number)) {
    throw new Error(`Postgres pg_stat_statements row has invalid ${field}: ${String(raw)}`);
  }
  return number;
}

function nullableInteger(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') {
    return null;
  }
  const number = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

function nullableIsoTimestamp(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') {
    return null;
  }
  if (raw instanceof Date) {
    return raw.toISOString();
  }
  const date = new Date(String(raw));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function firstRow(result: QueryResultLike, context: string): { row: unknown[]; headers: Map<string, number> } {
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Postgres historic-SQL ${context} query returned no rows`);
  }
  return { row, headers: indexes(result.headers) };
}

function isMissingPgssRelation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /relation ["']?pg_stat_statements["']? does not exist/i.test(message);
}

function isPgssPreloadRequired(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /pg_stat_statements.*shared_preload_libraries/i.test(message);
}

function extensionMissingError(cause: unknown, message?: string): HistoricSqlExtensionMissingError {
  return new HistoricSqlExtensionMissingError({
    dialect: 'postgres',
    message: message ?? 'pg_stat_statements extension is not installed in the connection database.',
    remediation: POSTGRES_EXTENSION_REMEDIATION,
    cause,
  });
}

function grantsMissingError(): HistoricSqlGrantsMissingError {
  return new HistoricSqlGrantsMissingError({
    dialect: 'postgres',
    message: 'Postgres connection role lacks pg_read_all_stats for historic-SQL ingest.',
    remediation: POSTGRES_GRANTS_REMEDIATION,
  });
}

function mapSnapshotRow(row: unknown[], headerIndexes: Map<string, number>): PostgresPgssRow {
  return {
    queryid: requiredString(value(row, headerIndexes, 'queryid'), 'queryid'),
    userid: requiredString(value(row, headerIndexes, 'userid'), 'userid'),
    username: nullableString(value(row, headerIndexes, 'username')),
    dbid: requiredString(value(row, headerIndexes, 'dbid'), 'dbid'),
    database: nullableString(value(row, headerIndexes, 'database')),
    query: requiredString(value(row, headerIndexes, 'query'), 'query'),
    calls: Math.trunc(requiredFiniteNumber(value(row, headerIndexes, 'calls'), 'calls')),
    totalExecTime: requiredFiniteNumber(value(row, headerIndexes, 'total_exec_time'), 'total_exec_time'),
    meanExecTime: requiredFiniteNumber(value(row, headerIndexes, 'mean_exec_time'), 'mean_exec_time'),
    totalRows: Math.trunc(requiredFiniteNumber(value(row, headerIndexes, 'total_rows'), 'total_rows')),
  };
}

export class PostgresPgssQueryHistoryReader implements PostgresPgssReader {
  async probe(client: unknown): Promise<PostgresPgssProbeResult> {
    const pgClient = queryClient(client);
    const versionResult = await execute(pgClient, VERSION_SQL);
    const { row: versionRow, headers: versionHeaders } = firstRow(versionResult, 'version probe');
    const serverVersionNum = requiredFiniteNumber(
      value(versionRow, versionHeaders, 'server_version_num'),
      'server_version_num',
    );
    const pgServerVersion = requiredString(value(versionRow, versionHeaders, 'server_version'), 'server_version');

    if (serverVersionNum < 140000) {
      throw new HistoricSqlVersionUnsupportedError({
        dialect: 'postgres',
        detectedVersion: pgServerVersion,
        minimumVersion: 'PostgreSQL 14',
      });
    }

    try {
      await execute(pgClient, EXTENSION_PROBE_SQL);
    } catch (error) {
      if (isMissingPgssRelation(error)) {
        throw extensionMissingError(error);
      }
      if (isPgssPreloadRequired(error)) {
        throw extensionMissingError(
          error,
          'pg_stat_statements is installed but not loaded via shared_preload_libraries.',
        );
      }
      throw error;
    }

    const grantsResult = await execute(pgClient, GRANTS_PROBE_SQL);
    const { row: grantsRow, headers: grantsHeaders } = firstRow(grantsResult, 'grant probe');
    if (value(grantsRow, grantsHeaders, 'has_role') !== true) {
      throw grantsMissingError();
    }

    const trackingResult = await execute(pgClient, TRACKING_PROBE_SQL);
    const { row: trackingRow, headers: trackingHeaders } = firstRow(trackingResult, 'tracking probe');
    const track = nullableString(value(trackingRow, trackingHeaders, 'track'));

    const maxResult = await execute(pgClient, MAX_SETTING_PROBE_SQL);
    const { row: maxRow, headers: maxHeaders } = firstRow(maxResult, 'max-setting probe');
    const pgssMax = nullableInteger(value(maxRow, maxHeaders, 'max'));

    const warnings: string[] = [];
    if (track === 'none') {
      warnings.push('pg_stat_statements.track is none; set it to top or all in the Postgres parameter group or config');
    }
    if (pgssMax !== null && pgssMax < RECOMMENDED_PGSS_MAX) {
      warnings.push(
        `pg_stat_statements.max is ${pgssMax}; set it to at least ${RECOMMENDED_PGSS_MAX} to reduce query-template eviction churn`,
      );
    }

    return { pgServerVersion, warnings };
  }

  async readSnapshot(
    client: unknown,
    options: { minCalls: number; maxTemplates: number },
  ): Promise<PostgresPgssSnapshot> {
    const pgClient = queryClient(client);
    const snapshotResult = await execute(pgClient, SNAPSHOT_SQL, [options.minCalls, options.maxTemplates]);
    const snapshotHeaders = indexes(snapshotResult.headers);
    const statsResult = await execute(pgClient, STATS_INFO_SQL);
    const { row: statsRow, headers: statsHeaders } = firstRow(statsResult, 'stats-info');

    return {
      statsResetAt: nullableIsoTimestamp(value(statsRow, statsHeaders, 'stats_reset')),
      deallocCount: nullableInteger(value(statsRow, statsHeaders, 'dealloc')),
      rows: snapshotResult.rows.map((row) => mapSnapshotRow(row, snapshotHeaders)),
    };
  }
}
