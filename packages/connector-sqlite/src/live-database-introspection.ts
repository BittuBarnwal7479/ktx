import type { LiveDatabaseIntrospectionPort } from '@ktx/context/ingest';
import type { KtxProjectConnectionConfig } from '@ktx/context/project';
import { KtxSqliteScanConnector, type KtxSqliteConnectionConfig } from './connector.js';

export interface CreateSqliteLiveDatabaseIntrospectionOptions {
  projectDir?: string;
  connections: Record<string, KtxProjectConnectionConfig>;
  now?: () => Date;
}

export function createSqliteLiveDatabaseIntrospection(
  options: CreateSqliteLiveDatabaseIntrospectionOptions,
): LiveDatabaseIntrospectionPort {
  return {
    async extractSchema(connectionId: string) {
      const connection = options.connections[connectionId] as KtxSqliteConnectionConfig | undefined;
      const connector = new KtxSqliteScanConnector({
        connectionId,
        connection,
        projectDir: options.projectDir,
        now: options.now,
      });
      try {
        return await connector.introspect({ connectionId, driver: 'sqlite' }, { runId: `sqlite-${connectionId}` });
      } finally {
        await connector.cleanup();
      }
    },
  };
}
