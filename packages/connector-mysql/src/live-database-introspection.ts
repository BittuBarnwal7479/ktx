import type { LiveDatabaseIntrospectionPort } from '@ktx/context/ingest';
import type { KtxProjectConnectionConfig } from '@ktx/context/project';
import {
  KtxMysqlScanConnector,
  type KtxMysqlConnectionConfig,
  type KtxMysqlEndpointResolver,
  type KtxMysqlPoolFactory,
} from './connector.js';

interface CreateMysqlLiveDatabaseIntrospectionOptions {
  connections: Record<string, KtxProjectConnectionConfig>;
  poolFactory?: KtxMysqlPoolFactory;
  endpointResolver?: KtxMysqlEndpointResolver;
  now?: () => Date;
}

export function createMysqlLiveDatabaseIntrospection(
  options: CreateMysqlLiveDatabaseIntrospectionOptions,
): LiveDatabaseIntrospectionPort {
  return {
    async extractSchema(connectionId: string) {
      const connection = options.connections[connectionId] as KtxMysqlConnectionConfig | undefined;
      const connector = new KtxMysqlScanConnector({
        connectionId,
        connection,
        poolFactory: options.poolFactory,
        endpointResolver: options.endpointResolver,
        now: options.now,
      });
      try {
        return await connector.introspect({ connectionId, driver: 'mysql' }, { runId: `mysql-${connectionId}` });
      } finally {
        await connector.cleanup();
      }
    },
  };
}
