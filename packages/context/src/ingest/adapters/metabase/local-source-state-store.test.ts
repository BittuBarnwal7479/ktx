import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalMetabaseSourceStateReader } from './local-source-state-store.js';

describe('LocalMetabaseSourceStateReader', () => {
  let tempDir: string;
  let store: LocalMetabaseSourceStateReader;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-metabase-local-state-'));
    store = new LocalMetabaseSourceStateReader({ dbPath: join(tempDir, '.ktx', 'db.sqlite') });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('round-trips hydrated source state through SQLite', async () => {
    await store.replaceSourceState({
      connectionId: 'prod-metabase',
      syncMode: 'ONLY',
      defaultTagNames: ['analytics', 'curated'],
      selections: [
        { selectionType: 'collection', metabaseObjectId: 10 },
        { selectionType: 'item', metabaseObjectId: 99 },
      ],
      mappings: [
        {
          metabaseDatabaseId: 1,
          metabaseDatabaseName: 'Analytics',
          metabaseEngine: 'postgres',
          metabaseHost: 'warehouse.internal',
          metabaseDbName: 'analytics',
          targetConnectionId: 'warehouse',
          syncEnabled: true,
          source: 'cli',
        },
      ],
    });

    await expect(store.getSourceState('prod-metabase')).resolves.toEqual({
      syncMode: 'ONLY',
      defaultTagNames: ['analytics', 'curated'],
      selections: [
        { selectionType: 'collection', metabaseObjectId: 10 },
        { selectionType: 'item', metabaseObjectId: 99 },
      ],
      mappings: [
        {
          metabaseDatabaseId: 1,
          metabaseDatabaseName: 'Analytics',
          metabaseEngine: 'postgres',
          targetConnectionId: 'warehouse',
          syncEnabled: true,
        },
      ],
    });
  });

  it('excludes unhydrated mappings from getSourceState and exposes them through the side accessor', async () => {
    await store.replaceSourceState({
      connectionId: 'prod-metabase',
      syncMode: 'ALL',
      defaultTagNames: [],
      selections: [],
      mappings: [
        {
          metabaseDatabaseId: 1,
          metabaseDatabaseName: null,
          metabaseEngine: null,
          metabaseHost: null,
          metabaseDbName: null,
          targetConnectionId: 'warehouse',
          syncEnabled: true,
          source: 'ktx.yaml',
        },
        {
          metabaseDatabaseId: 2,
          metabaseDatabaseName: 'Sandbox',
          metabaseEngine: 'postgres',
          metabaseHost: 'warehouse.internal',
          metabaseDbName: 'sandbox',
          targetConnectionId: 'warehouse',
          syncEnabled: true,
          source: 'refresh',
        },
      ],
    });

    const state = await store.getSourceState('prod-metabase');
    expect(state.mappings.map((mapping) => mapping.metabaseDatabaseId)).toEqual([2]);
    await expect(store.getUnhydratedSyncEnabledMappingIds('prod-metabase')).resolves.toEqual([1]);
  });

  it('defaults missing sync config to ALL with no tags or selections', async () => {
    await store.replaceSourceState({
      connectionId: 'prod-metabase',
      mappings: [
        {
          metabaseDatabaseId: 3,
          metabaseDatabaseName: 'Warehouse',
          metabaseEngine: 'postgres',
          metabaseHost: null,
          metabaseDbName: null,
          targetConnectionId: null,
          syncEnabled: false,
          source: 'refresh',
        },
      ],
    });

    await expect(store.getSourceState('prod-metabase')).resolves.toMatchObject({
      syncMode: 'ALL',
      defaultTagNames: [],
      selections: [],
    });
  });

  it('supports command-sized mapping writes and reads', async () => {
    await store.upsertDatabaseMapping({
      connectionId: 'prod-metabase',
      metabaseDatabaseId: 1,
      targetConnectionId: 'prod-warehouse',
      syncEnabled: true,
      source: 'cli',
    });
    await store.setSyncState({
      connectionId: 'prod-metabase',
      syncMode: 'ONLY',
      defaultTagNames: ['analytics'],
      selections: [{ selectionType: 'collection', metabaseObjectId: 12 }],
    });

    await expect(store.listDatabaseMappings('prod-metabase')).resolves.toEqual([
      {
        metabaseDatabaseId: 1,
        metabaseDatabaseName: null,
        metabaseEngine: null,
        metabaseHost: null,
        metabaseDbName: null,
        targetConnectionId: 'prod-warehouse',
        syncEnabled: true,
        source: 'cli',
      },
    ]);
    await expect(store.getUnhydratedSyncEnabledMappingIds('prod-metabase')).resolves.toEqual([1]);
    await expect(store.getSourceState('prod-metabase')).resolves.toMatchObject({
      syncMode: 'ONLY',
      defaultTagNames: ['analytics'],
      selections: [{ selectionType: 'collection', metabaseObjectId: 12 }],
      mappings: [],
    });
  });

  it('refreshes discovered database metadata while preserving user mapping intent', async () => {
    await store.upsertDatabaseMapping({
      connectionId: 'prod-metabase',
      metabaseDatabaseId: 1,
      targetConnectionId: 'prod-warehouse',
      syncEnabled: true,
      source: 'cli',
    });

    await store.refreshDiscoveredDatabases({
      connectionId: 'prod-metabase',
      discovered: [
        { id: 1, name: 'Analytics', engine: 'postgres', host: 'pg.internal', dbName: 'analytics' },
        { id: 2, name: 'Sandbox', engine: 'postgres', host: 'pg.internal', dbName: 'sandbox' },
      ],
    });

    await expect(store.listDatabaseMappings('prod-metabase')).resolves.toEqual([
      {
        metabaseDatabaseId: 1,
        metabaseDatabaseName: 'Analytics',
        metabaseEngine: 'postgres',
        metabaseHost: 'pg.internal',
        metabaseDbName: 'analytics',
        targetConnectionId: 'prod-warehouse',
        syncEnabled: true,
        source: 'cli',
      },
      {
        metabaseDatabaseId: 2,
        metabaseDatabaseName: 'Sandbox',
        metabaseEngine: 'postgres',
        metabaseHost: 'pg.internal',
        metabaseDbName: 'sandbox',
        targetConnectionId: null,
        syncEnabled: false,
        source: 'refresh',
      },
    ]);
  });

  it('updates sync-enabled, clears scoped rows, and applies bulk state in one call', async () => {
    await store.replaceSourceState({
      connectionId: 'prod-metabase',
      mappings: [
        {
          metabaseDatabaseId: 1,
          metabaseDatabaseName: 'Analytics',
          metabaseEngine: 'postgres',
          metabaseHost: 'pg.internal',
          metabaseDbName: 'analytics',
          targetConnectionId: 'prod-warehouse',
          syncEnabled: true,
          source: 'refresh',
        },
        {
          metabaseDatabaseId: 2,
          metabaseDatabaseName: 'Sandbox',
          metabaseEngine: 'postgres',
          metabaseHost: 'pg.internal',
          metabaseDbName: 'sandbox',
          targetConnectionId: 'staging-warehouse',
          syncEnabled: true,
          source: 'refresh',
        },
      ],
    });

    await store.setMappingSyncEnabled({
      connectionId: 'prod-metabase',
      metabaseDatabaseId: 2,
      syncEnabled: false,
    });
    await store.clearDatabaseMappings({ connectionId: 'prod-metabase', metabaseDatabaseId: 1 });

    await expect(store.listDatabaseMappings('prod-metabase')).resolves.toEqual([
      {
        metabaseDatabaseId: 2,
        metabaseDatabaseName: 'Sandbox',
        metabaseEngine: 'postgres',
        metabaseHost: 'pg.internal',
        metabaseDbName: 'sandbox',
        targetConnectionId: 'staging-warehouse',
        syncEnabled: false,
        source: 'refresh',
      },
    ]);
  });

  it('seeds unhydrated yaml intent without exposing it through getSourceState', async () => {
    await store.applyYamlBootstrap({
      connectionId: 'prod-metabase',
      syncMode: 'ALL',
      defaultTagNames: ['ktx'],
      selections: [{ selectionType: 'collection', metabaseObjectId: 12 }],
      mappings: [{ metabaseDatabaseId: 1, targetConnectionId: 'prod-warehouse', syncEnabled: true }],
    });

    await expect(store.getUnhydratedSyncEnabledMappingIds('prod-metabase')).resolves.toEqual([1]);
    await expect(store.getSourceState('prod-metabase')).resolves.toMatchObject({
      syncMode: 'ALL',
      defaultTagNames: ['ktx'],
      selections: [{ selectionType: 'collection', metabaseObjectId: 12 }],
      mappings: [],
    });
    await expect(store.listDatabaseMappings('prod-metabase')).resolves.toMatchObject([
      {
        metabaseDatabaseId: 1,
        metabaseDatabaseName: null,
        targetConnectionId: 'prod-warehouse',
        syncEnabled: true,
        source: 'ktx.yaml',
      },
    ]);
  });

  it('applies yaml target intent onto refresh metadata but does not overwrite cli rows', async () => {
    await store.refreshDiscoveredDatabases({
      connectionId: 'prod-metabase',
      discovered: [{ id: 1, name: 'Analytics', engine: 'postgres', host: 'db.test', dbName: 'analytics' }],
    });
    await store.upsertDatabaseMapping({
      connectionId: 'prod-metabase',
      metabaseDatabaseId: 2,
      targetConnectionId: 'cli-warehouse',
      syncEnabled: true,
      source: 'cli',
    });

    await store.applyYamlBootstrap({
      connectionId: 'prod-metabase',
      syncMode: 'EXCEPT',
      defaultTagNames: [],
      selections: [{ selectionType: 'item', metabaseObjectId: 99 }],
      mappings: [
        { metabaseDatabaseId: 1, targetConnectionId: 'yaml-warehouse', syncEnabled: true },
        { metabaseDatabaseId: 2, targetConnectionId: 'yaml-warehouse', syncEnabled: false },
      ],
    });

    await expect(store.listDatabaseMappings('prod-metabase')).resolves.toMatchObject([
      {
        metabaseDatabaseId: 1,
        metabaseDatabaseName: 'Analytics',
        metabaseEngine: 'postgres',
        targetConnectionId: 'yaml-warehouse',
        syncEnabled: true,
        source: 'ktx.yaml',
      },
      {
        metabaseDatabaseId: 2,
        targetConnectionId: 'cli-warehouse',
        syncEnabled: true,
        source: 'cli',
      },
    ]);
  });
});
