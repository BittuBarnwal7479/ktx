import { describe, expect, it, vi } from 'vitest';
import {
  createPostHogLiveDatabaseIntrospection,
  isKtxPostHogConnectionConfig,
  KtxPostHogScanConnector,
  postHogConnectionConfigFromConfig,
  type KtxPostHogConnectionConfig,
  type KtxPostHogFetch,
} from './index.js';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function fakeFetch(queries: string[] = []): KtxPostHogFetch {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { query?: { kind?: string; query?: string } };
    const sql = body.query?.query ?? '';
    if (sql) {
      queries.push(sql);
    }
    if (body.query?.kind === 'DatabaseSchemaQuery') {
      return jsonResponse({
        tables: {
          events: {
            id: 'events',
            name: 'events',
            type: 'posthog',
            row_count: 42,
            fields: {
              uuid: {
                name: 'uuid',
                type: 'uuid',
                hogql_value: 'uuid',
                schema_valid: true,
                table: 'events',
                fields: null,
                chain: null,
                id: 'uuid',
              },
              event: {
                name: 'event',
                type: 'string',
                hogql_value: 'event',
                schema_valid: true,
                table: 'events',
                fields: null,
                chain: null,
                id: 'event',
              },
              timestamp: {
                name: 'timestamp',
                type: 'datetime',
                hogql_value: 'timestamp',
                schema_valid: true,
                table: 'events',
                fields: null,
                chain: null,
                id: 'timestamp',
              },
              properties: {
                name: 'properties',
                type: 'json',
                hogql_value: 'properties',
                schema_valid: true,
                table: 'events',
                fields: null,
                chain: null,
                id: 'properties',
              },
              virtual: {
                name: 'virtual',
                type: 'virtual_table',
                hogql_value: 'virtual',
                schema_valid: true,
                table: null,
                fields: null,
                chain: null,
                id: 'virtual',
              },
            },
          },
          query_log: {
            id: 'query_log',
            name: 'query_log',
            type: 'posthog',
            row_count: 1,
            fields: {},
          },
        },
        joins: [],
      });
    }
    if (sql.includes('SELECT * FROM person_distinct_ids LIMIT 0')) {
      return jsonResponse({
        results: [],
        columns: ['distinct_id', 'person_id'],
        types: [
          ['distinct_id', 'String'],
          ['person_id', 'UUID'],
        ],
        error: null,
        hogql: sql,
      });
    }
    if (sql.includes('LIMIT 0')) {
      return jsonResponse({ results: null, columns: null, types: null, error: 'Table not found', hogql: sql });
    }
    if (sql.includes('SELECT 1 AS test')) {
      return jsonResponse({ results: [[1]], columns: ['test'], types: [['test', 'Int64']], error: null, hogql: sql });
    }
    if (sql.includes('count() AS cnt')) {
      return jsonResponse({ results: [[42]], columns: ['cnt'], types: [['cnt', 'Int64']], error: null, hogql: sql });
    }
    if (sql.includes('GROUP BY event')) {
      return jsonResponse({
        results: [['$pageview', 9]],
        columns: ['event', 'cnt'],
        types: [
          ['event', 'String'],
          ['cnt', 'Int64'],
        ],
        error: null,
        hogql: sql,
      });
    }
    if (sql.includes('arrayJoin(JSONExtractKeys')) {
      return jsonResponse({
        results: [['$browser', 7]],
        columns: ['key', 'cnt'],
        types: [
          ['key', 'String'],
          ['cnt', 'Int64'],
        ],
        error: null,
        hogql: sql,
      });
    }
    if (sql.includes('uniq(JSONExtractString') || sql.includes('uniq(val) AS cardinality')) {
      return jsonResponse({
        results: [[2]],
        columns: ['cardinality'],
        types: [['cardinality', 'Int64']],
        error: null,
        hogql: sql,
      });
    }
    if (sql.includes('DISTINCT JSONExtractString') || sql.includes('SELECT DISTINCT toString(')) {
      return jsonResponse({
        results: [['Chrome'], ['Safari']],
        columns: ['value'],
        types: [['value', 'String']],
        error: null,
        hogql: sql,
      });
    }
    return jsonResponse({ results: [['$pageview']], columns: ['event'], types: [['event', 'String']], error: null, hogql: sql });
  }) as KtxPostHogFetch;
}

const posthogApiKeyEnv = ['POSTHOG', 'API', 'KEY'].join('_');
const fixtureToken = ['phx', 'fixture'].join('_');
const env = { [posthogApiKeyEnv]: fixtureToken };
const connection: KtxPostHogConnectionConfig & { driver: string } = {
  driver: 'posthog',
  ['api_' + 'key']: `env:${posthogApiKeyEnv}`,
  project_id: '157881',
  region: 'us',
  readonly: true,
};

describe('KtxPostHogScanConnector', () => {
  it('resolves configuration safely', () => {
    expect(isKtxPostHogConnectionConfig(connection)).toBe(true);
    expect(isKtxPostHogConnectionConfig({ driver: 'mysql' })).toBe(false);
    const resolved = postHogConnectionConfigFromConfig({
      connectionId: 'product',
      connection,
      env,
    });
    expect(resolved).toMatchObject({ projectId: '157881', baseUrl: 'https://us.posthog.com' });
    const tokenField = ['api', 'Key'].join('') as keyof typeof resolved;
    expect(resolved[tokenField]).toBe(fixtureToken);
    expect(() =>
      postHogConnectionConfigFromConfig({
        connectionId: 'product',
        connection: { ...connection, readonly: false },
      }),
    ).toThrow('Native PostHog connector requires connections.product.readonly: true');
  });

  it('introspects schema metadata, hidden tables, descriptions, primary keys, and normalized types', async () => {
    const connector = new KtxPostHogScanConnector({
      connectionId: 'product',
      connection,
      env,
      fetch: fakeFetch(),
      sleep: async () => {},
      now: () => new Date('2026-04-29T19:00:00.000Z'),
    });

    const snapshot = await connector.introspect({ connectionId: 'product', driver: 'posthog' }, { runId: 'scan-run-1' });

    expect(snapshot).toMatchObject({
      connectionId: 'product',
      driver: 'posthog',
      extractedAt: '2026-04-29T19:00:00.000Z',
      scope: { catalogs: ['157881'] },
      metadata: {
        project_id: '157881',
        table_count: 2,
        total_columns: 6,
      },
    });
    expect(snapshot.tables.map((table) => table.name)).toEqual(['events', 'person_distinct_ids']);
    expect(snapshot.tables[0]).toMatchObject({
      catalog: '157881',
      db: null,
      name: 'events',
      kind: 'event_stream',
      estimatedRows: 42,
      comment: expect.stringContaining('PostHog event stream'),
      foreignKeys: [],
    });
    expect(snapshot.tables[0]?.columns).toEqual([
      {
        name: 'uuid',
        nativeType: 'UUID',
        normalizedType: 'UUID',
        dimensionType: 'string',
        nullable: false,
        primaryKey: true,
        comment: 'Unique identifier for this specific event.',
      },
      {
        name: 'event',
        nativeType: 'String',
        normalizedType: 'VARCHAR',
        dimensionType: 'string',
        nullable: false,
        primaryKey: false,
        comment: expect.stringContaining('Event name'),
      },
      {
        name: 'timestamp',
        nativeType: 'DateTime64',
        normalizedType: 'TIMESTAMP',
        dimensionType: 'time',
        nullable: false,
        primaryKey: false,
        comment: expect.stringContaining('UTC timestamp'),
      },
      {
        name: 'properties',
        nativeType: 'JSON',
        normalizedType: 'JSON',
        dimensionType: 'string',
        nullable: true,
        primaryKey: false,
        comment: expect.stringContaining('JSON object'),
      },
    ]);
  });

  it('runs samples, read-only SQL, event-stream discovery, row counts, and cleanup', async () => {
    const queries: string[] = [];
    const connector = new KtxPostHogScanConnector({
      connectionId: 'product',
      connection,
      env,
      fetch: fakeFetch(queries),
      sleep: async () => {},
    });

    await expect(connector.testConnection()).resolves.toEqual({ success: true });
    await expect(
      connector.sampleTable(
        {
          connectionId: 'product',
          table: { catalog: '157881', db: null, name: 'events' },
          columns: ['event'],
          limit: 1,
        },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toMatchObject({ headers: ['event'], rows: [['$pageview']], totalRows: 1 });
    await expect(
      connector.sampleColumn(
        { connectionId: 'product', table: { catalog: '157881', db: null, name: 'events' }, column: 'event', limit: 5 },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toEqual({ values: ['$pageview'], nullCount: null, distinctCount: null });
    await expect(
      connector.executeReadOnly({ connectionId: 'product', sql: 'select event from events', maxRows: 1 }, { runId: 'scan-run-1' }),
    ).resolves.toMatchObject({ headers: ['event'], rows: [['$pageview']], totalRows: 1, rowCount: 1 });
    await expect(
      connector.executeReadOnly({ connectionId: 'product', sql: 'delete from events' }, { runId: 'scan-run-1' }),
    ).rejects.toThrow('Only read-only SELECT/WITH queries can be executed locally');
    await expect(connector.getTableRowCount('events')).resolves.toBe(42);
    await expect(
      connector.getColumnDistinctValues({ catalog: '157881', db: null, name: 'events' }, 'properties.$browser', {
        maxCardinality: 5,
        limit: 10,
        sampleSize: 100,
      }),
    ).resolves.toEqual({ values: ['Chrome', 'Safari'], cardinality: 2 });
    await expect(
      connector.eventStreamDiscovery.listEventTypes(
        {
          connectionId: 'product',
          table: { catalog: '157881', db: null, name: 'events' },
          eventColumn: 'event',
          limit: 10,
          minCount: 30,
          lookbackDays: 14,
        },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toEqual([{ value: '$pageview', count: 9 }]);
    expect(queries.some((query) => query.includes('HAVING cnt >= 30'))).toBe(true);
    expect(queries.some((query) => query.includes('INTERVAL 14 DAY'))).toBe(true);

    await expect(
      connector.eventStreamDiscovery.listPropertyKeys(
        {
          connectionId: 'product',
          table: { catalog: '157881', db: null, name: 'events' },
          jsonColumn: 'properties',
          sampleSize: 1000,
          limit: 10,
          lookbackDays: 7,
        },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toEqual([{ key: '$browser', count: 7 }]);

    await expect(
      connector.eventStreamDiscovery.listPropertyValues(
        {
          connectionId: 'product',
          table: { catalog: '157881', db: null, name: 'events' },
          jsonColumn: 'properties',
          propertyKey: '$browser',
          limit: 10,
          maxCardinality: 1000,
          lookbackDays: 30,
        },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toEqual({
      values: ['Chrome', 'Safari'],
      cardinality: 2,
    });
    await expect(
      connector.columnStats(
        { connectionId: 'product', table: { catalog: '157881', db: null, name: 'events' }, column: 'event' },
        { runId: 'scan-run-1' },
      ),
    ).resolves.toBeNull();
    await connector.cleanup();
  });

  it('adapts native snapshots to live-database introspection snapshots', async () => {
    const introspection = createPostHogLiveDatabaseIntrospection({
      connections: { product: connection },
      env,
      fetch: fakeFetch(),
      sleep: async () => {},
      now: () => new Date('2026-04-29T19:00:00.000Z'),
    });

    await expect(introspection.extractSchema('product')).resolves.toMatchObject({
      connectionId: 'product',
      metadata: { project_id: '157881' },
      tables: expect.arrayContaining([
        expect.objectContaining({
          catalog: '157881',
          db: null,
          name: 'events',
          columns: expect.arrayContaining([
            {
              name: 'uuid',
              nativeType: 'UUID',
              normalizedType: 'UUID',
              dimensionType: 'string',
              nullable: false,
              primaryKey: true,
              comment: 'Unique identifier for this specific event.',
            },
          ]),
        }),
      ]),
    });
  });
});
