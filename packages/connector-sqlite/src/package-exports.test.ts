import { describe, expect, it } from 'vitest';

describe('@ktx/connector-sqlite package exports', () => {
  it('exports the native SQLite scan connector surface', async () => {
    const connector = await import('./index.js');

    expect(connector.KtxSqliteDialect).toBeTypeOf('function');
    expect(connector.KtxSqliteScanConnector).toBeTypeOf('function');
    expect(connector.createSqliteLiveDatabaseIntrospection).toBeTypeOf('function');
    expect(connector.isKtxSqliteConnectionConfig).toBeTypeOf('function');
    expect(connector.sqliteDatabasePathFromConfig).toBeTypeOf('function');
  });
});
