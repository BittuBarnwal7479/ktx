import { describe, expect, it } from 'vitest';

describe('@ktx/connector-sqlserver package exports', () => {
  it('exports public connector APIs during package bootstrap', async () => {
    const connector = await import('./index.js');

    expect(connector.KtxSqlServerDialect).toBeTypeOf('function');
    expect(connector.KtxSqlServerScanConnector).toBeTypeOf('function');
    expect(connector.createSqlServerLiveDatabaseIntrospection).toBeTypeOf('function');
    expect(connector.sqlServerConnectionPoolConfigFromConfig).toBeTypeOf('function');
  });
});
