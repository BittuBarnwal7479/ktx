import { describe, expect, it } from 'vitest';
import * as connector from './index.js';

describe('@ktx/connector-snowflake package exports', () => {
  it('exports public connector, dialect, and introspection APIs', () => {
    expect(connector.KtxSnowflakeDialect).toBeTypeOf('function');
    expect(connector.KtxSnowflakeScanConnector).toBeTypeOf('function');
    expect(connector.snowflakeConnectionConfigFromConfig).toBeTypeOf('function');
    expect(connector.createSnowflakeLiveDatabaseIntrospection).toBeTypeOf('function');
  });
});
