import { describe, expect, it, vi } from 'vitest';
import { PostgresPgssReader } from './postgres-pgss-reader.js';

describe('PostgresPgssReader aggregate path', () => {
  it('aggregates pg_stat_statements rows by queryid and query', async () => {
    const executeQuery = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('pg_stat_statements_info')) {
        return { headers: ['stats_reset', 'dealloc'], rows: [['2026-05-01T00:00:00.000Z', 1]] };
      }
      expect(sql).toContain('GROUP BY queryid, query');
      expect(sql).toContain('HAVING SUM(calls) >= $1');
      expect(params).toEqual([5]);
      return {
        headers: ['template_id', 'canonical_sql', 'executions', 'distinct_users', 'mean_ms', 'rows_produced', 'top_users'],
        rows: [
          [
            '123',
            'select status from public.orders',
            '42',
            '3',
            '11.5',
            '100',
            JSON.stringify([{ user: 'analyst', executions: 40 }]),
          ],
        ],
      };
    });

    const reader = new PostgresPgssReader();
    const rows = [];
    for await (const row of reader.fetchAggregated(
      { executeQuery },
      { start: new Date('2026-02-10T00:00:00.000Z'), end: new Date('2026-05-11T00:00:00.000Z') },
      { dialect: 'postgres', minExecutions: 5, windowDays: 90, concurrency: 12, filters: { dropTrivialProbes: true }, redactionPatterns: [], staleArchiveAfterDays: 90 },
    )) {
      rows.push(row);
    }

    expect(rows).toEqual([
      {
        templateId: '123',
        canonicalSql: 'select status from public.orders',
        dialect: 'postgres',
        stats: {
          executions: 42,
          distinctUsers: 3,
          firstSeen: '2026-05-01T00:00:00.000Z',
          lastSeen: '2026-05-11T00:00:00.000Z',
          p50RuntimeMs: 11.5,
          p95RuntimeMs: 11.5,
          errorRate: 0,
          rowsProduced: 100,
        },
        topUsers: [{ user: 'analyst', executions: 40 }],
      },
    ]);
  });
});
