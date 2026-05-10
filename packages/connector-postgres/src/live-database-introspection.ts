import type { LiveDatabaseIntrospectionPort } from '@ktx/context/ingest';
import type { KtxProjectConnectionConfig } from '@ktx/context/project';
import {
  KtxPostgresScanConnector,
  type KtxPostgresConnectionConfig,
  type KtxPostgresEndpointResolver,
  type KtxPostgresPoolFactory,
} from './connector.js';

interface CreatePostgresLiveDatabaseIntrospectionOptions {
  connections: Record<string, KtxProjectConnectionConfig>;
  poolFactory?: KtxPostgresPoolFactory;
  endpointResolver?: KtxPostgresEndpointResolver;
  now?: () => Date;
}

export function createPostgresLiveDatabaseIntrospection(
  options: CreatePostgresLiveDatabaseIntrospectionOptions,
): LiveDatabaseIntrospectionPort {
  return {
    async extractSchema(connectionId: string) {
      const connection = options.connections[connectionId] as KtxPostgresConnectionConfig | undefined;
      const connector = new KtxPostgresScanConnector({
        connectionId,
        connection,
        poolFactory: options.poolFactory,
        endpointResolver: options.endpointResolver,
        now: options.now,
      });
      try {
        return await connector.introspect({ connectionId, driver: 'postgres' }, { runId: `postgres-${connectionId}` });
      } finally {
        await connector.cleanup();
      }
    },
  };
}
