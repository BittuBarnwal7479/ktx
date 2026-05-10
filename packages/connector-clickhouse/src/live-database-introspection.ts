import type { LiveDatabaseIntrospectionPort } from '@ktx/context/ingest';
import type { KtxProjectConnectionConfig } from '@ktx/context/project';
import {
  KtxClickHouseScanConnector,
  type KtxClickHouseClientFactory,
  type KtxClickHouseConnectionConfig,
  type KtxClickHouseEndpointResolver,
} from './connector.js';

interface CreateClickHouseLiveDatabaseIntrospectionOptions {
  connections: Record<string, KtxProjectConnectionConfig>;
  clientFactory?: KtxClickHouseClientFactory;
  endpointResolver?: KtxClickHouseEndpointResolver;
  now?: () => Date;
}

export function createClickHouseLiveDatabaseIntrospection(
  options: CreateClickHouseLiveDatabaseIntrospectionOptions,
): LiveDatabaseIntrospectionPort {
  return {
    async extractSchema(connectionId: string) {
      const connection = options.connections[connectionId] as KtxClickHouseConnectionConfig | undefined;
      const connector = new KtxClickHouseScanConnector({
        connectionId,
        connection,
        clientFactory: options.clientFactory,
        endpointResolver: options.endpointResolver,
        now: options.now,
      });
      try {
        return await connector.introspect(
          { connectionId, driver: 'clickhouse' },
          { runId: `clickhouse-${connectionId}` },
        );
      } finally {
        await connector.cleanup();
      }
    },
  };
}
