import { describe, expect, it } from 'vitest';

describe('@ktx/connector-mysql package exports', () => {
  it('exports the native MySQL scan surface', async () => {
    const connector = await import('./index.js');

    expect(connector.KtxMysqlDialect).toBeTypeOf('function');
    expect(connector.KtxMysqlScanConnector).toBeTypeOf('function');
    expect(connector.createMysqlLiveDatabaseIntrospection).toBeTypeOf('function');
    expect(connector.isKtxMysqlConnectionConfig).toBeTypeOf('function');
    expect(connector.mysqlConnectionPoolConfigFromConfig).toBeTypeOf('function');
  });
});
