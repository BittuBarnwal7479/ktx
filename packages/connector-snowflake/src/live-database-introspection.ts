import type { LiveDatabaseIntrospectionPort } from '@ktx/context/ingest';
import type { KtxProjectConnectionConfig } from '@ktx/context/project';
import {
  KtxSnowflakeScanConnector,
  type KtxSnowflakeConnectionConfig,
  type KtxSnowflakeDriverFactory,
  type KtxSnowflakeSdkOptionsProvider,
} from './connector.js';

interface CreateSnowflakeLiveDatabaseIntrospectionOptions {
  connections: Record<string, KtxProjectConnectionConfig>;
  driverFactory?: KtxSnowflakeDriverFactory;
  sdkOptionsProvider?: KtxSnowflakeSdkOptionsProvider;
  now?: () => Date;
}

export function createSnowflakeLiveDatabaseIntrospection(
  options: CreateSnowflakeLiveDatabaseIntrospectionOptions,
): LiveDatabaseIntrospectionPort {
  return {
    async extractSchema(connectionId: string) {
      const connection = options.connections[connectionId] as KtxSnowflakeConnectionConfig | undefined;
      const connector = new KtxSnowflakeScanConnector({
        connectionId,
        connection,
        driverFactory: options.driverFactory,
        sdkOptionsProvider: options.sdkOptionsProvider,
        now: options.now,
      });
      try {
        return await connector.introspect(
          { connectionId, driver: 'snowflake' },
          { runId: `snowflake-${connectionId}` },
        );
      } finally {
        await connector.cleanup();
      }
    },
  };
}
