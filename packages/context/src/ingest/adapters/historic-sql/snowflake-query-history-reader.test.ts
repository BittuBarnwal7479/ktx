import { describe, expect, it, vi } from 'vitest';
import { HistoricSqlGrantsMissingError } from './errors.js';
import { SnowflakeHistoricSqlQueryHistoryReader } from './snowflake-query-history-reader.js';

interface FakeQueryResult {
  headers: string[];
  rows: unknown[][];
  totalRows: number;
  error?: string;
}

function queryClient(results: FakeQueryResult[]) {
  const executeQuery = vi.fn(async (_query: string) => {
    const next = results.shift();
    if (!next) {
      throw new Error('unexpected query');
    }
    return next;
  });
  return { executeQuery };
}

function firstQuery(client: ReturnType<typeof queryClient>): string {
  const call = client.executeQuery.mock.calls[0];
  if (!call) {
    throw new Error('expected query client to be called');
  }
  return call[0];
}

describe('SnowflakeHistoricSqlQueryHistoryReader', () => {
  it('probes SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY', async () => {
    const client = queryClient([{ headers: ['1'], rows: [[1]], totalRows: 1 }]);
    const reader = new SnowflakeHistoricSqlQueryHistoryReader();

    await expect(reader.probe(client)).resolves.toBeUndefined();

    expect(client.executeQuery).toHaveBeenCalledWith(
      'SELECT 1 FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY LIMIT 1',
    );
  });

  it('turns probe result errors into HistoricSqlGrantsMissingError', async () => {
    const client = queryClient([{ headers: [], rows: [], totalRows: 0, error: 'Object does not exist or not authorized' }]);
    const reader = new SnowflakeHistoricSqlQueryHistoryReader();

    await expect(reader.probe(client)).rejects.toMatchObject({
      name: 'HistoricSqlGrantsMissingError',
      dialect: 'snowflake',
      remediation: 'GRANT IMPORTED PRIVILEGES ON DATABASE SNOWFLAKE TO ROLE <connection role>;',
    });
  });

  it('turns thrown probe failures into HistoricSqlGrantsMissingError', async () => {
    const client = {
      executeQuery: vi.fn(async () => {
        throw new Error('permission denied');
      }),
    };
    const reader = new SnowflakeHistoricSqlQueryHistoryReader();

    await expect(reader.probe(client)).rejects.toBeInstanceOf(HistoricSqlGrantsMissingError);
  });

  it('fetches query-history rows with cursor and maps them into RawQueryRow shape', async () => {
    const client = queryClient([
      {
        headers: [
          'QUERY_ID',
          'QUERY_TEXT',
          'USER_NAME',
          'ROLE_NAME',
          'WAREHOUSE_NAME',
          'DATABASE_NAME',
          'SCHEMA_NAME',
          'START_TIME',
          'END_TIME',
          'TOTAL_ELAPSED_TIME',
          'ROWS_PRODUCED',
          'EXECUTION_STATUS',
          'ERROR_CODE',
          'ERROR_MESSAGE',
        ],
        rows: [
          [
            '01a',
            "SELECT count(*) FROM ANALYTICS.ORDERS WHERE STATUS = 'paid'",
            'ANALYST_A',
            'ANALYST_ROLE',
            'WH_XS',
            'ANALYTICS',
            'PUBLIC',
            '2026-05-04T10:00:00.000Z',
            '2026-05-04T10:00:01.250Z',
            1250,
            12,
            'SUCCESS',
            null,
            null,
          ],
          [
            '01b',
            'SELECT * FROM MISSING_TABLE',
            'ANALYST_B',
            'ANALYST_ROLE',
            'WH_XS',
            'ANALYTICS',
            'PUBLIC',
            new Date('2026-05-04T10:05:00.000Z'),
            null,
            null,
            null,
            'FAILED_WITH_ERROR',
            '002003',
            'SQL compilation error',
          ],
        ],
        totalRows: 2,
      },
    ]);
    const reader = new SnowflakeHistoricSqlQueryHistoryReader();

    const rows = [];
    for await (const row of reader.fetch(
      client,
      {
        start: new Date('2026-05-01T00:00:00.000Z'),
        end: new Date('2026-05-04T12:00:00.000Z'),
      },
      '2026-05-03T00:00:00.000Z',
    )) {
      rows.push(row);
    }

    expect(client.executeQuery).toHaveBeenCalledTimes(1);
    const sql = firstQuery(client);
    expect(sql).toContain('FROM SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY');
    expect(sql).toContain("START_TIME >= '2026-05-03T00:00:00.000Z'::TIMESTAMP_TZ");
    expect(sql).toContain("START_TIME < '2026-05-04T12:00:00.000Z'::TIMESTAMP_TZ");
    expect(sql).toContain('ORDER BY START_TIME ASC, QUERY_ID ASC');
    expect(sql).toContain('ROWS_PRODUCED');

    expect(rows).toEqual([
      {
        id: '01a',
        sql: "SELECT count(*) FROM ANALYTICS.ORDERS WHERE STATUS = 'paid'",
        user: 'ANALYST_A',
        startedAt: '2026-05-04T10:00:00.000Z',
        endedAt: '2026-05-04T10:00:01.250Z',
        runtimeMs: 1250,
        rowsProduced: 12,
        success: true,
        errorMessage: null,
      },
      {
        id: '01b',
        sql: 'SELECT * FROM MISSING_TABLE',
        user: 'ANALYST_B',
        startedAt: '2026-05-04T10:05:00.000Z',
        endedAt: null,
        runtimeMs: null,
        rowsProduced: null,
        success: false,
        errorMessage: '002003: SQL compilation error',
      },
    ]);
  });

  it('uses the window start when no cursor is available', async () => {
    const client = queryClient([{ headers: ['QUERY_ID'], rows: [], totalRows: 0 }]);
    const reader = new SnowflakeHistoricSqlQueryHistoryReader();

    for await (const _row of reader.fetch(client, {
      start: new Date('2026-02-03T12:00:00.000Z'),
      end: new Date('2026-05-04T12:00:00.000Z'),
    })) {
      throw new Error('empty result should not yield rows');
    }

    const sql = firstQuery(client);
    expect(sql).toContain("START_TIME >= '2026-02-03T12:00:00.000Z'::TIMESTAMP_TZ");
  });

  it('fetches aggregated Snowflake query templates', async () => {
    const client = queryClient([
      {
        headers: [
          'template_id',
          'canonical_sql',
          'executions',
          'distinct_users',
          'first_seen',
          'last_seen',
          'p50_ms',
          'p95_ms',
          'error_rate',
          'rows_produced',
          'top_users',
        ],
        rows: [
          [
            'hash-1',
            'select status from orders',
            42,
            3,
            '2026-05-01T00:00:00.000Z',
            '2026-05-11T00:00:00.000Z',
            12,
            40,
            0.05,
            100,
            JSON.stringify([{ user: 'ANALYST', executions: 1 }]),
          ],
        ],
        totalRows: 1,
      },
    ]);
    const reader = new SnowflakeHistoricSqlQueryHistoryReader();

    const rows = [];
    for await (const row of reader.fetchAggregated(
      client,
      { start: new Date('2026-02-10T00:00:00.000Z'), end: new Date('2026-05-11T00:00:00.000Z') },
      { dialect: 'snowflake', minExecutions: 5, windowDays: 90, concurrency: 12, filters: { dropTrivialProbes: true }, redactionPatterns: [], staleArchiveAfterDays: 90 },
    )) {
      rows.push(row);
    }

    const sql = firstQuery(client);
    expect(sql).toContain('SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY');
    expect(sql).toContain('COUNT(*) AS executions');
    expect(sql).toContain('GROUP BY query_hash');
    expect(sql).toContain('HAVING COUNT(*) >= 5');
    expect(rows).toMatchObject([
      {
        templateId: 'hash-1',
        stats: {
          executions: 42,
          errorRate: 0.05,
        },
        topUsers: [{ user: 'ANALYST', executions: 1 }],
      },
    ]);
  });

  it('throws a clear error when the query client cannot execute SQL', async () => {
    const reader = new SnowflakeHistoricSqlQueryHistoryReader();

    await expect(async () => {
      for await (const _row of reader.fetch({}, { start: new Date(), end: new Date() })) {
        throw new Error('unreachable');
      }
    }).rejects.toThrow('Historic SQL Snowflake reader requires a query client with executeQuery(query)');
  });
});
