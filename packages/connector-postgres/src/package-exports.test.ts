import { describe, expect, it } from 'vitest';

describe('@ktx/connector-postgres package exports', () => {
  it('exports the connector, dialect, and live-database adapter', async () => {
    const connector = await import('./index.js');
    expect(connector.KtxPostgresDialect).toBeTypeOf('function');
    expect(connector.KtxPostgresScanConnector).toBeTypeOf('function');
    expect(connector.KtxPostgresHistoricSqlQueryClient).toBeTypeOf('function');
    expect(connector.createPostgresLiveDatabaseIntrospection).toBeTypeOf('function');
    expect(connector.isKtxPostgresConnectionConfig).toBeTypeOf('function');
    expect(connector.postgresPoolConfigFromConfig).toBeTypeOf('function');
  });
});
