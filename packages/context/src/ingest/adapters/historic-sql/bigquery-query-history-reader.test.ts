import { describe, expect, it, vi } from 'vitest';
import { BigQueryHistoricSqlQueryHistoryReader } from './bigquery-query-history-reader.js';
import { HistoricSqlGrantsMissingError } from './errors.js';

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

describe('BigQueryHistoricSqlQueryHistoryReader', () => {
  it('probes region-qualified INFORMATION_SCHEMA.JOBS_BY_PROJECT', async () => {
    const client = queryClient([{ headers: ['1'], rows: [[1]], totalRows: 1 }]);
    const reader = new BigQueryHistoricSqlQueryHistoryReader({ projectId: 'project-1', region: 'US' });

    await expect(reader.probe(client)).resolves.toBeUndefined();

    expect(client.executeQuery).toHaveBeenCalledWith(
      'SELECT 1 FROM `project-1.region-us.INFORMATION_SCHEMA.JOBS_BY_PROJECT` LIMIT 1',
    );
  });

  it('turns probe result errors into HistoricSqlGrantsMissingError', async () => {
    const client = queryClient([{ headers: [], rows: [], totalRows: 0, error: 'Access Denied: jobs.listAll' }]);
    const reader = new BigQueryHistoricSqlQueryHistoryReader({ projectId: 'project-1', region: 'us-central1' });

    await expect(reader.probe(client)).rejects.toMatchObject({
      name: 'HistoricSqlGrantsMissingError',
      dialect: 'bigquery',
      remediation:
        'Grant roles/bigquery.resourceViewer on the BigQuery project, or grant a custom role containing bigquery.jobs.listAll.',
    });
  });

  it('turns thrown probe failures into HistoricSqlGrantsMissingError', async () => {
    const client = {
      executeQuery: vi.fn(async () => {
        throw new Error('permission denied');
      }),
    };
    const reader = new BigQueryHistoricSqlQueryHistoryReader({ projectId: 'project-1', region: 'US' });

    await expect(reader.probe(client)).rejects.toBeInstanceOf(HistoricSqlGrantsMissingError);
  });

  it('fetches BigQuery jobs with cursor and maps them into RawQueryRow shape without rowsProduced', async () => {
    const client = queryClient([
      {
        headers: [
          'job_id',
          'query',
          'user_email',
          'creation_time',
          'end_time',
          'runtime_ms',
          'total_slot_ms',
          'total_bytes_processed',
          'state',
          'error_reason',
          'error_message',
          'statement_type',
        ],
        rows: [
          [
            'bquxjob_1',
            "SELECT COUNT(*) FROM `project-1.analytics.orders` WHERE status = 'paid'",
            'analyst-a@example.test',
            '2026-05-04T10:00:00.000Z',
            '2026-05-04T10:00:01.250Z',
            1250,
            3106,
            161164718,
            'DONE',
            null,
            null,
            'SELECT',
          ],
          [
            'bquxjob_2',
            'SELECT * FROM `project-1.analytics.missing_table`',
            'analyst-b@example.test',
            new Date('2026-05-04T10:05:00.000Z'),
            null,
            null,
            0,
            0,
            'DONE',
            'notFound',
            'Not found: Table project-1.analytics.missing_table',
            'SELECT',
          ],
        ],
        totalRows: 2,
      },
    ]);
    const reader = new BigQueryHistoricSqlQueryHistoryReader({ projectId: 'project-1', region: 'US' });

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
    expect(sql).toContain('FROM `project-1.region-us.INFORMATION_SCHEMA.JOBS_BY_PROJECT`');
    expect(sql).toContain("creation_time >= TIMESTAMP('2026-05-03T00:00:00.000Z')");
    expect(sql).toContain("creation_time < TIMESTAMP('2026-05-04T12:00:00.000Z')");
    expect(sql).toContain("job_type = 'QUERY'");
    expect(sql).toContain("(statement_type IS NULL OR statement_type != 'SCRIPT')");
    expect(sql).toContain('ORDER BY creation_time ASC, job_id ASC');
    expect(sql).toContain('total_slot_ms');
    expect(sql).toContain('total_bytes_processed');
    expect(sql).not.toMatch(/total_rows/i);

    expect(rows).toEqual([
      {
        id: 'bquxjob_1',
        sql: "SELECT COUNT(*) FROM `project-1.analytics.orders` WHERE status = 'paid'",
        user: 'analyst-a@example.test',
        startedAt: '2026-05-04T10:00:00.000Z',
        endedAt: '2026-05-04T10:00:01.250Z',
        runtimeMs: 1250,
        success: true,
        errorMessage: null,
      },
      {
        id: 'bquxjob_2',
        sql: 'SELECT * FROM `project-1.analytics.missing_table`',
        user: 'analyst-b@example.test',
        startedAt: '2026-05-04T10:05:00.000Z',
        endedAt: null,
        runtimeMs: null,
        success: false,
        errorMessage: 'notFound: Not found: Table project-1.analytics.missing_table',
      },
    ]);
  });

  it('uses the window start when no cursor is available', async () => {
    const client = queryClient([{ headers: ['job_id'], rows: [], totalRows: 0 }]);
    const reader = new BigQueryHistoricSqlQueryHistoryReader({ projectId: 'project-1', region: 'EU' });

    for await (const _row of reader.fetch(client, {
      start: new Date('2026-02-03T12:00:00.000Z'),
      end: new Date('2026-05-04T12:00:00.000Z'),
    })) {
      throw new Error('empty result should not yield rows');
    }

    const sql = firstQuery(client);
    expect(sql).toContain('FROM `project-1.region-eu.INFORMATION_SCHEMA.JOBS_BY_PROJECT`');
    expect(sql).toContain("creation_time >= TIMESTAMP('2026-02-03T12:00:00.000Z')");
  });

  it('fetches aggregated BigQuery query templates', async () => {
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
            null,
            JSON.stringify([{ user: 'analyst@example.test', executions: 1 }]),
          ],
        ],
        totalRows: 1,
      },
    ]);
    const reader = new BigQueryHistoricSqlQueryHistoryReader({ projectId: 'demo', region: 'us' });

    const rows = [];
    for await (const row of reader.fetchAggregated(
      client,
      { start: new Date('2026-02-10T00:00:00.000Z'), end: new Date('2026-05-11T00:00:00.000Z') },
      { dialect: 'bigquery', minExecutions: 5, windowDays: 90, concurrency: 12, filters: { dropTrivialProbes: true }, redactionPatterns: [], staleArchiveAfterDays: 90 },
    )) {
      rows.push(row);
    }

    const sql = firstQuery(client);
    expect(sql).toContain('COUNT(*) AS executions');
    expect(sql).toContain('COUNT(DISTINCT user_email) AS distinct_users');
    expect(sql).toContain('GROUP BY query_hash');
    expect(sql).toContain('HAVING COUNT(*) >= 5');
    expect(rows).toMatchObject([
      {
        templateId: 'hash-1',
        stats: {
          executions: 42,
          errorRate: 0.05,
        },
        topUsers: [{ user: 'analyst@example.test', executions: 1 }],
      },
    ]);
  });

  it('throws a clear error when the query client cannot execute SQL', async () => {
    const reader = new BigQueryHistoricSqlQueryHistoryReader({ projectId: 'project-1', region: 'US' });

    await expect(async () => {
      for await (const _row of reader.fetch({}, { start: new Date(), end: new Date() })) {
        throw new Error('unreachable');
      }
    }).rejects.toThrow('Historic SQL BigQuery reader requires a query client with executeQuery(query)');
  });

  it('rejects unsafe project and region identifiers before building SQL', () => {
    expect(() => new BigQueryHistoricSqlQueryHistoryReader({ projectId: 'project`1', region: 'US' })).toThrow(
      'Invalid BigQuery project id for historic-SQL ingest: project`1',
    );
    expect(() => new BigQueryHistoricSqlQueryHistoryReader({ projectId: 'project-1', region: 'US;DROP' })).toThrow(
      'Invalid BigQuery region for historic-SQL ingest: US;DROP',
    );
  });
});
