import { readFile } from 'node:fs/promises';
import { localConnectionToWarehouseDescriptor } from '@ktx/context/connections';
import {
  DEFAULT_METABASE_CLIENT_CONFIG,
  DefaultLookerConnectionClientFactory,
  DefaultMetabaseConnectionClientFactory,
  LocalLookerRuntimeStore,
  LocalMetabaseSourceStateReader,
  computeLookerMappingDrift,
  computeMetabaseMappingDrift,
  discoverLookerConnections,
  discoverMetabaseDatabases,
  lookerCredentialsFromLocalConnection,
  metabaseRuntimeConfigFromLocalConnection,
  seedLocalMappingStateFromKtxYaml,
  validateLookerMappings,
  validateMappingPhysicalMatch,
  type LookerMappingClient,
  type MetabaseRuntimeClient,
  type MetabaseSyncMode,
} from '@ktx/context/ingest';
import { type KtxLocalProject, ktxLocalStateDbPath, loadKtxProject } from '@ktx/context/project';
import type { KtxCliIo } from '../index.js';
import { profileMark } from '../startup-profile.js';

profileMark('module:commands/connection-mapping');

export type KtxConnectionMappingArgs =
  | { command: 'list'; projectDir: string; connectionId: string; json: boolean }
  | {
      command: 'set';
      projectDir: string;
      connectionId: string;
      field: 'databaseMappings' | 'connectionMappings';
      key: string;
      value: string;
    }
  | { command: 'apply-bulk'; projectDir: string; connectionId: string; filePath: string }
  | {
      command: 'set-sync-enabled';
      projectDir: string;
      connectionId: string;
      metabaseDatabaseId: number;
      enabled: boolean;
    }
  | { command: 'sync-state-get'; projectDir: string; connectionId: string; json: boolean }
  | {
      command: 'sync-state-set';
      projectDir: string;
      connectionId: string;
      syncMode: MetabaseSyncMode;
      collectionIds: number[];
      itemIds: number[];
      tagNames: string[];
    }
  | { command: 'refresh'; projectDir: string; connectionId: string; autoAccept: boolean }
  | { command: 'validate'; projectDir: string; connectionId: string }
  | { command: 'clear'; projectDir: string; connectionId: string; metabaseDatabaseId?: number; mappingKey?: string };

interface KtxConnectionMappingDeps {
  createMetabaseClient?: (
    project: KtxLocalProject,
    connectionId: string,
  ) => Promise<Pick<MetabaseRuntimeClient, 'getDatabases' | 'cleanup'>>;
  createLookerClient?: (
    project: KtxLocalProject,
    connectionId: string,
  ) => Promise<Pick<LookerMappingClient, 'listLookerConnections'> & { cleanup?(): Promise<void> }>;
}

interface MetabaseBulkMappingPayload {
  databaseMappings?: Record<string, string | null>;
  syncEnabled?: Record<string, boolean>;
  syncMode?: MetabaseSyncMode;
  selections?: { collections?: number[]; items?: number[] };
  defaultTagNames?: string[];
}

function parseId(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

async function createDefaultMetabaseClient(
  project: KtxLocalProject,
  connectionId: string,
): Promise<Pick<MetabaseRuntimeClient, 'getDatabases' | 'cleanup'>> {
  const factory = new DefaultMetabaseConnectionClientFactory(
    (metabaseConnectionId) =>
      metabaseRuntimeConfigFromLocalConnection(metabaseConnectionId, project.config.connections[metabaseConnectionId]),
    DEFAULT_METABASE_CLIENT_CONFIG,
  );
  return factory.createClient(connectionId);
}

async function createDefaultLookerClient(
  project: KtxLocalProject,
  connectionId: string,
): Promise<Pick<LookerMappingClient, 'listLookerConnections'> & { cleanup?(): Promise<void> }> {
  const factory = new DefaultLookerConnectionClientFactory({
    async resolve(lookerConnectionId) {
      return lookerCredentialsFromLocalConnection(lookerConnectionId, project.config.connections[lookerConnectionId]);
    },
  });
  return factory.createClient(connectionId) as unknown as Pick<LookerMappingClient, 'listLookerConnections'> & {
    cleanup?(): Promise<void>;
  };
}

function isLookerConnection(project: KtxLocalProject, connectionId: string): boolean {
  return String(project.config.connections[connectionId]?.driver ?? '').toLowerCase() === 'looker';
}

function assertLookerConnection(project: KtxLocalProject, connectionId: string): void {
  if (!isLookerConnection(project, connectionId)) {
    throw new Error(`Connection "${connectionId}" is not a Looker connection`);
  }
}

function assertMetabaseConnection(project: KtxLocalProject, connectionId: string): void {
  const connection = project.config.connections[connectionId];
  if (!connection || String(connection.driver).toLowerCase() !== 'metabase') {
    throw new Error(`Connection "${connectionId}" is not a Metabase connection`);
  }
}

function assertTargetConnection(project: KtxLocalProject, connectionId: string): void {
  if (!project.config.connections[connectionId]) {
    throw new Error(`Target connection "${connectionId}" does not exist`);
  }
}

function targetPhysicalInfo(project: KtxLocalProject, connectionId: string) {
  const descriptor = localConnectionToWarehouseDescriptor(connectionId, project.config.connections[connectionId]);
  if (!descriptor) {
    return { connection_type: 'UNKNOWN' };
  }
  return {
    connection_type: descriptor.connection_type,
    host: descriptor.host ?? null,
    database: descriptor.database ?? null,
    account: descriptor.account ?? null,
    project_id: descriptor.project_id ?? null,
    dataset_id: descriptor.dataset_id ?? null,
    ...descriptor.connection_params,
  };
}

function renderMapping(
  row: Awaited<ReturnType<LocalMetabaseSourceStateReader['listDatabaseMappings']>>[number],
): string {
  const name = row.metabaseDatabaseName ?? 'unhydrated';
  const target = row.targetConnectionId ?? '[unmapped]';
  return `${row.metabaseDatabaseId} -> ${target} (${name}, sync: ${row.syncEnabled ? 'on' : 'off'}, source: ${
    row.source
  })`;
}

function renderLookerMapping(row: Awaited<ReturnType<LocalLookerRuntimeStore['listConnectionMappings']>>[number]): string {
  const target = row.ktxConnectionId ?? '[unmapped]';
  const metadata = [row.lookerDialect, row.lookerHost, row.lookerDatabase].filter(Boolean).join(', ');
  return `${row.lookerConnectionName} -> ${target}${metadata ? ` (${metadata}, source: ${row.source})` : ` (source: ${row.source})`}`;
}

export async function runKtxConnectionMapping(
  args: KtxConnectionMappingArgs,
  io: KtxCliIo = process,
  deps: KtxConnectionMappingDeps = {},
): Promise<number> {
  try {
    const project = await loadKtxProject({ projectDir: args.projectDir });
    await seedLocalMappingStateFromKtxYaml(project, args.connectionId);
    if (isLookerConnection(project, args.connectionId)) {
      assertLookerConnection(project, args.connectionId);
      const store = new LocalLookerRuntimeStore({ dbPath: ktxLocalStateDbPath(project) });

      if (args.command === 'list') {
        const rows = await store.listConnectionMappings(args.connectionId);
        io.stdout.write(args.json ? `${JSON.stringify(rows, null, 2)}\n` : `${rows.map(renderLookerMapping).join('\n')}\n`);
        return 0;
      }

      if (args.command === 'set') {
        if (args.field !== 'connectionMappings') {
          throw new Error('Looker mapping set requires connectionMappings <lookerConnectionName>=<targetConnectionId>');
        }
        assertTargetConnection(project, args.value);
        await store.upsertConnectionMapping({
          lookerConnectionId: args.connectionId,
          lookerConnectionName: args.key,
          ktxConnectionId: args.value,
          source: 'cli',
        });
        io.stdout.write(`Set connectionMappings.${args.key} = ${args.value}\n`);
        return 0;
      }

      if (args.command === 'refresh') {
        const client = await (deps.createLookerClient ?? createDefaultLookerClient)(project, args.connectionId);
        try {
          const discovered = await discoverLookerConnections(client);
          const drift = computeLookerMappingDrift({
            storedMappings: await store.readMappings(args.connectionId),
            discovered,
          });
          if (args.autoAccept) {
            await store.refreshDiscoveredConnections({ lookerConnectionId: args.connectionId, discovered });
          }
          io.stdout.write(`Discovery: ${discovered.length} ${discovered.length === 1 ? 'connection' : 'connections'}\n`);
          io.stdout.write(`Unmapped discovered: ${drift.unmappedDiscovered.length}\n`);
          io.stdout.write(`Stale mappings: ${drift.staleMappings.length}\n`);
          return 0;
        } finally {
          await client.cleanup?.();
        }
      }

      if (args.command === 'validate') {
        const knownKtxConnectionIds = new Set(Object.keys(project.config.connections));
        const knownConnectionTypes = new Map(
          Object.entries(project.config.connections).map(([id, _config]) => [id, targetPhysicalInfo(project, id).connection_type]),
        );
        const validation = validateLookerMappings({
          mappings: await store.readMappings(args.connectionId),
          knownKtxConnectionIds,
          knownConnectionTypes,
        });
        if (!validation.ok) {
          for (const error of validation.errors) {
            io.stderr.write(`${error.key}: ${error.reason}\n`);
          }
          return 1;
        }
        io.stdout.write(`Mapping validation passed: ${args.connectionId}\n`);
        return 0;
      }

      if (args.command === 'clear') {
        await store.clearConnectionMappings({
          lookerConnectionId: args.connectionId,
          lookerConnectionName: args.mappingKey ?? (args.metabaseDatabaseId ? String(args.metabaseDatabaseId) : undefined),
        });
        io.stdout.write(
          args.mappingKey
            ? `Cleared connectionMappings.${args.mappingKey}\n`
            : `Cleared mappings for ${args.connectionId}\n`,
        );
        return 0;
      }

      throw new Error(`Looker connection mapping does not support ${args.command}`);
    }

    assertMetabaseConnection(project, args.connectionId);
    const store = new LocalMetabaseSourceStateReader({ dbPath: ktxLocalStateDbPath(project) });

    if (args.command === 'list') {
      const rows = await store.listDatabaseMappings(args.connectionId);
      io.stdout.write(args.json ? `${JSON.stringify(rows, null, 2)}\n` : `${rows.map(renderMapping).join('\n')}\n`);
      return 0;
    }

    if (args.command === 'set') {
      assertTargetConnection(project, args.value);
      await store.upsertDatabaseMapping({
        connectionId: args.connectionId,
        metabaseDatabaseId: parseId(args.key, 'metabaseDatabaseId'),
        targetConnectionId: args.value,
        syncEnabled: true,
        source: 'cli',
      });
      io.stdout.write(`Set databaseMappings.${args.key} = ${args.value}\n`);
      return 0;
    }

    if (args.command === 'apply-bulk') {
      const payload = JSON.parse(await readFile(args.filePath, 'utf8')) as MetabaseBulkMappingPayload;
      const existingState = await store.getSourceState(args.connectionId);
      const existingRows = await store.listDatabaseMappings(args.connectionId);
      const existingById = new Map(existingRows.map((row) => [row.metabaseDatabaseId, row]));
      const databaseMappings = payload.databaseMappings ?? {};
      for (const targetConnectionId of Object.values(databaseMappings)) {
        if (targetConnectionId) {
          assertTargetConnection(project, targetConnectionId);
        }
      }
      const mappingIds = new Set([
        ...existingRows.map((row) => row.metabaseDatabaseId),
        ...Object.keys(databaseMappings).map((id) => parseId(id, 'metabaseDatabaseId')),
        ...Object.keys(payload.syncEnabled ?? {}).map((id) => parseId(id, 'metabaseDatabaseId')),
      ]);
      await store.replaceSourceState({
        connectionId: args.connectionId,
        syncMode: payload.syncMode ?? existingState.syncMode,
        defaultTagNames: payload.defaultTagNames ?? existingState.defaultTagNames,
        selections:
          payload.selections === undefined
            ? existingState.selections
            : [
                ...(payload.selections.collections ?? []).map((id) => ({
                  selectionType: 'collection' as const,
                  metabaseObjectId: id,
                })),
                ...(payload.selections.items ?? []).map((id) => ({
                  selectionType: 'item' as const,
                  metabaseObjectId: id,
                })),
              ],
        mappings: [...mappingIds]
          .sort((a, b) => a - b)
          .map((id) => {
            const existing = existingById.get(id);
            return {
              metabaseDatabaseId: id,
              metabaseDatabaseName: existing?.metabaseDatabaseName ?? null,
              metabaseEngine: existing?.metabaseEngine ?? null,
              metabaseHost: existing?.metabaseHost ?? null,
              metabaseDbName: existing?.metabaseDbName ?? null,
              targetConnectionId: databaseMappings[String(id)] ?? existing?.targetConnectionId ?? null,
              syncEnabled: payload.syncEnabled?.[String(id)] ?? existing?.syncEnabled ?? false,
              source: 'cli',
            };
          }),
      });
      io.stdout.write(`Applied bulk mappings for ${args.connectionId}\n`);
      return 0;
    }

    if (args.command === 'set-sync-enabled') {
      await store.setMappingSyncEnabled({
        connectionId: args.connectionId,
        metabaseDatabaseId: args.metabaseDatabaseId,
        syncEnabled: args.enabled,
      });
      io.stdout.write(`Set syncEnabled.${args.metabaseDatabaseId} = ${args.enabled}\n`);
      return 0;
    }

    if (args.command === 'sync-state-get') {
      const state = await store.getSourceState(args.connectionId);
      const payload = {
        syncMode: state.syncMode,
        selections: state.selections,
        defaultTagNames: state.defaultTagNames,
      };
      io.stdout.write(args.json ? `${JSON.stringify(payload, null, 2)}\n` : `${payload.syncMode}\n`);
      return 0;
    }

    if (args.command === 'sync-state-set') {
      await store.setSyncState({
        connectionId: args.connectionId,
        syncMode: args.syncMode,
        defaultTagNames: args.tagNames,
        selections: [
          ...args.collectionIds.map((id) => ({ selectionType: 'collection' as const, metabaseObjectId: id })),
          ...args.itemIds.map((id) => ({ selectionType: 'item' as const, metabaseObjectId: id })),
        ],
      });
      io.stdout.write(`Set sync state for ${args.connectionId}\n`);
      return 0;
    }

    if (args.command === 'refresh') {
      const client = await (deps.createMetabaseClient ?? createDefaultMetabaseClient)(project, args.connectionId);
      try {
        const discovered = await discoverMetabaseDatabases(client);
        const existing = Object.fromEntries(
          (await store.listDatabaseMappings(args.connectionId)).map((row) => [
            String(row.metabaseDatabaseId),
            row.targetConnectionId,
          ]),
        );
        const drift = computeMetabaseMappingDrift({ currentMappings: existing, discovered });
        if (args.autoAccept) {
          await store.refreshDiscoveredDatabases({ connectionId: args.connectionId, discovered });
        }
        io.stdout.write(`Discovery: ${discovered.length} ${discovered.length === 1 ? 'database' : 'databases'}\n`);
        io.stdout.write(`Unmapped discovered: ${drift.unmappedDiscovered.length}\n`);
        io.stdout.write(`Stale mappings: ${drift.staleMappings.length}\n`);
        return 0;
      } finally {
        await client.cleanup();
      }
    }

    if (args.command === 'validate') {
      const rows = await store.listDatabaseMappings(args.connectionId);
      const failures = rows.flatMap((row) => {
        if (!row.targetConnectionId) {
          return [];
        }
        const reason = validateMappingPhysicalMatch(
          { metabaseEngine: row.metabaseEngine, metabaseDbName: row.metabaseDbName, metabaseHost: row.metabaseHost },
          project.config.connections[row.targetConnectionId]
            ? targetPhysicalInfo(project, row.targetConnectionId)
            : { connection_type: 'UNKNOWN' },
        );
        return reason ? [`${row.metabaseDatabaseId}: ${reason}`] : [];
      });
      if (failures.length > 0) {
        for (const failure of failures) {
          io.stderr.write(`${failure}\n`);
        }
        return 1;
      }
      io.stdout.write(`Mapping validation passed: ${args.connectionId}\n`);
      return 0;
    }

    const metabaseDatabaseId = args.metabaseDatabaseId ?? (args.mappingKey ? parseId(args.mappingKey, 'metabaseDatabaseId') : undefined);
    await store.clearDatabaseMappings({ connectionId: args.connectionId, metabaseDatabaseId });
    io.stdout.write(
      metabaseDatabaseId
        ? `Cleared databaseMappings.${metabaseDatabaseId}\n`
        : `Cleared mappings for ${args.connectionId}\n`,
    );
    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
