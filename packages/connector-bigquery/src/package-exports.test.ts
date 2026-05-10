import { describe, expect, it } from 'vitest';
import * as connector from './index.js';

describe('@ktx/connector-bigquery exports', () => {
  it('exports public connector, dialect, and introspection APIs', () => {
    expect(connector.KtxBigQueryDialect).toBeTypeOf('function');
    expect(connector.KtxBigQueryScanConnector).toBeTypeOf('function');
    expect(connector.bigQueryConnectionConfigFromConfig).toBeTypeOf('function');
    expect(connector.createBigQueryLiveDatabaseIntrospection).toBeTypeOf('function');
  });
});
