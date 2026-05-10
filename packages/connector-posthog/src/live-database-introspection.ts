import type { LiveDatabaseIntrospectionPort } from '@ktx/context/ingest';
import type { KtxProjectConnectionConfig } from '@ktx/context/project';
import { KtxPostHogScanConnector, type KtxPostHogConnectionConfig, type KtxPostHogFetch } from './connector.js';

interface CreatePostHogLiveDatabaseIntrospectionOptions {
  connections: Record<string, KtxProjectConnectionConfig>;
  env?: NodeJS.ProcessEnv;
  fetch?: KtxPostHogFetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export function createPostHogLiveDatabaseIntrospection(
  options: CreatePostHogLiveDatabaseIntrospectionOptions,
): LiveDatabaseIntrospectionPort {
  return {
    async extractSchema(connectionId: string) {
      const connection = options.connections[connectionId] as KtxPostHogConnectionConfig | undefined;
      const connector = new KtxPostHogScanConnector({
        connectionId,
        connection,
        env: options.env,
        fetch: options.fetch,
        sleep: options.sleep,
        now: options.now,
      });
      try {
        return await connector.introspect({ connectionId, driver: 'posthog' }, { runId: `posthog-${connectionId}` });
      } finally {
        await connector.cleanup();
      }
    },
  };
}
