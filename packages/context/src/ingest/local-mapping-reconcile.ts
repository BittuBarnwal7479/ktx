import {
  ktxLocalStateDbPath,
  parseConnectionMappingBootstrap,
  type KtxLocalProject,
  type LookerMappingBootstrap,
  type MetabaseMappingBootstrap,
} from '../project/index.js';
import { LocalLookerRuntimeStore } from './adapters/looker/local-runtime-store.js';
import { LocalMetabaseSourceStateReader } from './adapters/metabase/local-source-state-store.js';

function metabaseSelections(bootstrap: MetabaseMappingBootstrap) {
  return [
    ...bootstrap.selections.collections.map((id) => ({ selectionType: 'collection' as const, metabaseObjectId: id })),
    ...bootstrap.selections.items.map((id) => ({ selectionType: 'item' as const, metabaseObjectId: id })),
  ];
}

function metabaseMappings(bootstrap: MetabaseMappingBootstrap) {
  const ids = new Set([...Object.keys(bootstrap.databaseMappings), ...Object.keys(bootstrap.syncEnabled)]);
  return [...ids]
    .map((id) => Number(id))
    .sort((a, b) => a - b)
    .map((id) => ({
      metabaseDatabaseId: id,
      targetConnectionId: bootstrap.databaseMappings[String(id)] ?? null,
      syncEnabled: bootstrap.syncEnabled[String(id)] ?? false,
    }));
}

function lookerMappings(bootstrap: LookerMappingBootstrap) {
  return Object.entries(bootstrap.connectionMappings)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([lookerConnectionName, ktxConnectionId]) => ({ lookerConnectionName, ktxConnectionId }));
}

export async function seedLocalMappingStateFromKtxYaml(project: KtxLocalProject, connectionId: string): Promise<void> {
  const connection = project.config.connections[connectionId];
  if (!connection) {
    return;
  }

  const bootstrap = parseConnectionMappingBootstrap(connectionId, connection);
  if (!bootstrap) {
    return;
  }

  const dbPath = ktxLocalStateDbPath(project);
  if (bootstrap.adapter === 'metabase') {
    await new LocalMetabaseSourceStateReader({ dbPath }).applyYamlBootstrap({
      connectionId,
      syncMode: bootstrap.syncMode,
      defaultTagNames: bootstrap.defaultTagNames,
      selections: metabaseSelections(bootstrap),
      mappings: metabaseMappings(bootstrap),
    });
    return;
  }

  if (bootstrap.adapter === 'looker') {
    await new LocalLookerRuntimeStore({ dbPath }).applyYamlBootstrap({
      lookerConnectionId: connectionId,
      mappings: lookerMappings(bootstrap),
    });
  }
}
