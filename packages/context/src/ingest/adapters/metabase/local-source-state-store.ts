import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { MetabaseSourceState, MetabaseSourceStateReader, MetabaseSourceStateSelection } from './source-state-port.js';
import type { MetabaseSyncMode } from './types.js';

export type LocalMetabaseMappingSource = 'ktx.yaml' | 'cli' | 'refresh';

interface LocalMetabaseSourceStateStoreOptions {
  dbPath: string;
  now?: () => Date;
}

export interface LocalMetabaseSourceStateMappingInput {
  metabaseDatabaseId: number;
  metabaseDatabaseName: string | null;
  metabaseEngine: string | null;
  metabaseHost: string | null;
  metabaseDbName: string | null;
  targetConnectionId: string | null;
  syncEnabled: boolean;
  source: LocalMetabaseMappingSource;
}

export interface ReplaceLocalMetabaseSourceStateInput {
  connectionId: string;
  syncMode?: MetabaseSyncMode;
  defaultTagNames?: string[];
  selections?: MetabaseSourceStateSelection[];
  mappings: LocalMetabaseSourceStateMappingInput[];
}

interface ApplyLocalMetabaseYamlBootstrapInput {
  connectionId: string;
  syncMode: MetabaseSyncMode;
  defaultTagNames: string[];
  selections: MetabaseSourceStateSelection[];
  mappings: Array<{
    metabaseDatabaseId: number;
    targetConnectionId: string | null;
    syncEnabled: boolean;
  }>;
}

export interface LocalMetabaseMappingListRow extends LocalMetabaseSourceStateMappingInput {}

export interface UpsertLocalMetabaseDatabaseMappingInput {
  connectionId: string;
  metabaseDatabaseId: number;
  targetConnectionId: string | null;
  syncEnabled: boolean;
  source: LocalMetabaseMappingSource;
}

export interface SetLocalMetabaseMappingSyncEnabledInput {
  connectionId: string;
  metabaseDatabaseId: number;
  syncEnabled: boolean;
}

export interface SetLocalMetabaseSyncStateInput {
  connectionId: string;
  syncMode: MetabaseSyncMode;
  defaultTagNames: string[];
  selections: MetabaseSourceStateSelection[];
}

export interface RefreshLocalMetabaseDiscoveredDatabasesInput {
  connectionId: string;
  discovered: Array<{
    id: number;
    name: string;
    engine: string;
    host: string | null;
    dbName: string | null;
  }>;
}

export interface ClearLocalMetabaseMappingsInput {
  connectionId: string;
  metabaseDatabaseId?: number;
}

interface SelectionRow {
  selection_type: 'collection' | 'item';
  metabase_object_id: number;
}

interface MappingRow {
  metabase_database_id: number;
  metabase_database_name: string | null;
  metabase_engine: string | null;
  target_connection_id: string | null;
  sync_enabled: number;
}

interface SyncConfigRow {
  sync_mode: MetabaseSyncMode;
  default_tag_names_json: string;
}

function parseDefaultTagNames(raw: string): string[] {
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
}

export class LocalMetabaseSourceStateReader implements MetabaseSourceStateReader {
  private readonly db: Database.Database;
  private readonly now: () => Date;

  constructor(options: LocalMetabaseSourceStateStoreOptions) {
    mkdirSync(dirname(options.dbPath), { recursive: true });
    this.db = new Database(options.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.now = options.now ?? (() => new Date());
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS local_metabase_sync_config (
        metabase_connection_id TEXT PRIMARY KEY,
        sync_mode TEXT NOT NULL,
        default_tag_names_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS local_metabase_selections (
        metabase_connection_id TEXT NOT NULL,
        selection_type TEXT NOT NULL,
        metabase_object_id INTEGER NOT NULL,
        PRIMARY KEY (metabase_connection_id, selection_type, metabase_object_id)
      );

      CREATE TABLE IF NOT EXISTS local_metabase_database_mappings (
        metabase_connection_id TEXT NOT NULL,
        metabase_database_id INTEGER NOT NULL,
        metabase_database_name TEXT,
        metabase_engine TEXT,
        metabase_host TEXT,
        metabase_db_name TEXT,
        target_connection_id TEXT,
        sync_enabled INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (metabase_connection_id, metabase_database_id)
      );
    `);
  }

  async applyYamlBootstrap(input: ApplyLocalMetabaseYamlBootstrapInput): Promise<void> {
    const timestamp = this.now().toISOString();
    const apply = this.db.transaction(() => {
      const syncConfigExists = this.db
        .prepare('SELECT 1 FROM local_metabase_sync_config WHERE metabase_connection_id = ?')
        .get(input.connectionId);
      if (!syncConfigExists) {
        this.db
          .prepare(
            `
            INSERT INTO local_metabase_sync_config (
              metabase_connection_id,
              sync_mode,
              default_tag_names_json,
              updated_at
            )
            VALUES (?, ?, ?, ?)
          `,
          )
          .run(input.connectionId, input.syncMode, JSON.stringify(input.defaultTagNames), timestamp);

        const insertSelection = this.db.prepare(`
          INSERT INTO local_metabase_selections (
            metabase_connection_id,
            selection_type,
            metabase_object_id
          )
          VALUES (?, ?, ?)
        `);
        for (const selection of input.selections) {
          insertSelection.run(input.connectionId, selection.selectionType, selection.metabaseObjectId);
        }
      }

      const existing = this.db.prepare(`
        SELECT target_connection_id, source
        FROM local_metabase_database_mappings
        WHERE metabase_connection_id = ? AND metabase_database_id = ?
      `);
      const insert = this.db.prepare(`
        INSERT INTO local_metabase_database_mappings (
          metabase_connection_id,
          metabase_database_id,
          metabase_database_name,
          metabase_engine,
          metabase_host,
          metabase_db_name,
          target_connection_id,
          sync_enabled,
          source,
          updated_at
        )
        VALUES (?, ?, NULL, NULL, NULL, NULL, ?, ?, 'ktx.yaml', ?)
      `);
      const updateRefreshRow = this.db.prepare(`
        UPDATE local_metabase_database_mappings
        SET target_connection_id = ?,
            sync_enabled = ?,
            source = 'ktx.yaml',
            updated_at = ?
        WHERE metabase_connection_id = ?
          AND metabase_database_id = ?
          AND source = 'refresh'
          AND target_connection_id IS NULL
      `);

      for (const mapping of input.mappings) {
        const row = existing.get(input.connectionId, mapping.metabaseDatabaseId) as
          | { target_connection_id: string | null; source: LocalMetabaseMappingSource }
          | undefined;
        if (!row) {
          insert.run(
            input.connectionId,
            mapping.metabaseDatabaseId,
            mapping.targetConnectionId,
            mapping.syncEnabled ? 1 : 0,
            timestamp,
          );
          continue;
        }
        if (row.source === 'refresh' && row.target_connection_id === null) {
          updateRefreshRow.run(
            mapping.targetConnectionId,
            mapping.syncEnabled ? 1 : 0,
            timestamp,
            input.connectionId,
            mapping.metabaseDatabaseId,
          );
        }
      }
    });

    apply();
  }

  async replaceSourceState(input: ReplaceLocalMetabaseSourceStateInput): Promise<void> {
    const timestamp = this.now().toISOString();
    const syncMode = input.syncMode ?? 'ALL';
    const selections = input.selections ?? [];
    const defaultTagNames = input.defaultTagNames ?? [];

    const replace = this.db.transaction(() => {
      this.db
        .prepare(
          `
          INSERT INTO local_metabase_sync_config (
            metabase_connection_id,
            sync_mode,
            default_tag_names_json,
            updated_at
          )
          VALUES (?, ?, ?, ?)
          ON CONFLICT(metabase_connection_id) DO UPDATE SET
            sync_mode = excluded.sync_mode,
            default_tag_names_json = excluded.default_tag_names_json,
            updated_at = excluded.updated_at
        `,
        )
        .run(input.connectionId, syncMode, JSON.stringify(defaultTagNames), timestamp);

      this.db.prepare('DELETE FROM local_metabase_selections WHERE metabase_connection_id = ?').run(input.connectionId);
      const insertSelection = this.db.prepare(`
        INSERT INTO local_metabase_selections (
          metabase_connection_id,
          selection_type,
          metabase_object_id
        )
        VALUES (?, ?, ?)
      `);
      for (const selection of selections) {
        insertSelection.run(input.connectionId, selection.selectionType, selection.metabaseObjectId);
      }

      this.db
        .prepare('DELETE FROM local_metabase_database_mappings WHERE metabase_connection_id = ?')
        .run(input.connectionId);
      const insertMapping = this.db.prepare(`
        INSERT INTO local_metabase_database_mappings (
          metabase_connection_id,
          metabase_database_id,
          metabase_database_name,
          metabase_engine,
          metabase_host,
          metabase_db_name,
          target_connection_id,
          sync_enabled,
          source,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const mapping of input.mappings) {
        insertMapping.run(
          input.connectionId,
          mapping.metabaseDatabaseId,
          mapping.metabaseDatabaseName,
          mapping.metabaseEngine,
          mapping.metabaseHost,
          mapping.metabaseDbName,
          mapping.targetConnectionId,
          mapping.syncEnabled ? 1 : 0,
          mapping.source,
          timestamp,
        );
      }
    });

    replace();
  }

  async listDatabaseMappings(connectionId: string): Promise<LocalMetabaseMappingListRow[]> {
    const rows = this.db
      .prepare(
        `
        SELECT
          metabase_database_id,
          metabase_database_name,
          metabase_engine,
          metabase_host,
          metabase_db_name,
          target_connection_id,
          sync_enabled,
          source
        FROM local_metabase_database_mappings
        WHERE metabase_connection_id = ?
        ORDER BY metabase_database_id
      `,
      )
      .all(connectionId) as Array<{
      metabase_database_id: number;
      metabase_database_name: string | null;
      metabase_engine: string | null;
      metabase_host: string | null;
      metabase_db_name: string | null;
      target_connection_id: string | null;
      sync_enabled: number;
      source: LocalMetabaseMappingSource;
    }>;

    return rows.map((row) => ({
      metabaseDatabaseId: row.metabase_database_id,
      metabaseDatabaseName: row.metabase_database_name,
      metabaseEngine: row.metabase_engine,
      metabaseHost: row.metabase_host,
      metabaseDbName: row.metabase_db_name,
      targetConnectionId: row.target_connection_id,
      syncEnabled: row.sync_enabled === 1,
      source: row.source,
    }));
  }

  async upsertDatabaseMapping(input: UpsertLocalMetabaseDatabaseMappingInput): Promise<void> {
    const timestamp = this.now().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO local_metabase_database_mappings (
          metabase_connection_id,
          metabase_database_id,
          metabase_database_name,
          metabase_engine,
          metabase_host,
          metabase_db_name,
          target_connection_id,
          sync_enabled,
          source,
          updated_at
        )
        VALUES (?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?)
        ON CONFLICT(metabase_connection_id, metabase_database_id) DO UPDATE SET
          target_connection_id = excluded.target_connection_id,
          sync_enabled = excluded.sync_enabled,
          source = excluded.source,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        input.connectionId,
        input.metabaseDatabaseId,
        input.targetConnectionId,
        input.syncEnabled ? 1 : 0,
        input.source,
        timestamp,
      );
  }

  async setMappingSyncEnabled(input: SetLocalMetabaseMappingSyncEnabledInput): Promise<void> {
    const timestamp = this.now().toISOString();
    this.db
      .prepare(
        `
        UPDATE local_metabase_database_mappings
        SET sync_enabled = ?, updated_at = ?
        WHERE metabase_connection_id = ? AND metabase_database_id = ?
      `,
      )
      .run(input.syncEnabled ? 1 : 0, timestamp, input.connectionId, input.metabaseDatabaseId);
  }

  async setSyncState(input: SetLocalMetabaseSyncStateInput): Promise<void> {
    const timestamp = this.now().toISOString();
    const write = this.db.transaction(() => {
      this.db
        .prepare(
          `
          INSERT INTO local_metabase_sync_config (
            metabase_connection_id,
            sync_mode,
            default_tag_names_json,
            updated_at
          )
          VALUES (?, ?, ?, ?)
          ON CONFLICT(metabase_connection_id) DO UPDATE SET
            sync_mode = excluded.sync_mode,
            default_tag_names_json = excluded.default_tag_names_json,
            updated_at = excluded.updated_at
        `,
        )
        .run(input.connectionId, input.syncMode, JSON.stringify(input.defaultTagNames), timestamp);

      this.db.prepare('DELETE FROM local_metabase_selections WHERE metabase_connection_id = ?').run(input.connectionId);
      const insertSelection = this.db.prepare(`
        INSERT INTO local_metabase_selections (
          metabase_connection_id,
          selection_type,
          metabase_object_id
        )
        VALUES (?, ?, ?)
      `);
      for (const selection of input.selections) {
        insertSelection.run(input.connectionId, selection.selectionType, selection.metabaseObjectId);
      }
    });

    write();
  }

  async refreshDiscoveredDatabases(input: RefreshLocalMetabaseDiscoveredDatabasesInput): Promise<void> {
    const timestamp = this.now().toISOString();
    const refresh = this.db.transaction(() => {
      const upsert = this.db.prepare(`
        INSERT INTO local_metabase_database_mappings (
          metabase_connection_id,
          metabase_database_id,
          metabase_database_name,
          metabase_engine,
          metabase_host,
          metabase_db_name,
          target_connection_id,
          sync_enabled,
          source,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, NULL, 0, 'refresh', ?)
        ON CONFLICT(metabase_connection_id, metabase_database_id) DO UPDATE SET
          metabase_database_name = excluded.metabase_database_name,
          metabase_engine = excluded.metabase_engine,
          metabase_host = excluded.metabase_host,
          metabase_db_name = excluded.metabase_db_name,
          updated_at = excluded.updated_at
      `);

      for (const database of input.discovered) {
        upsert.run(
          input.connectionId,
          database.id,
          database.name,
          database.engine,
          database.host,
          database.dbName,
          timestamp,
        );
      }
    });

    refresh();
  }

  async clearDatabaseMappings(input: ClearLocalMetabaseMappingsInput): Promise<void> {
    if (input.metabaseDatabaseId === undefined) {
      this.db.prepare('DELETE FROM local_metabase_database_mappings WHERE metabase_connection_id = ?').run(input.connectionId);
      return;
    }
    this.db
      .prepare('DELETE FROM local_metabase_database_mappings WHERE metabase_connection_id = ? AND metabase_database_id = ?')
      .run(input.connectionId, input.metabaseDatabaseId);
  }

  async getUnhydratedSyncEnabledMappingIds(connectionId: string): Promise<number[]> {
    const rows = this.db
      .prepare(
        `
        SELECT metabase_database_id
        FROM local_metabase_database_mappings
        WHERE metabase_connection_id = ?
          AND sync_enabled = 1
          AND target_connection_id IS NOT NULL
          AND metabase_database_name IS NULL
        ORDER BY metabase_database_id
      `,
      )
      .all(connectionId) as Array<{ metabase_database_id: number }>;
    return rows.map((row) => row.metabase_database_id);
  }

  async getSourceState(connectionId: string): Promise<MetabaseSourceState> {
    const config = this.db
      .prepare('SELECT sync_mode, default_tag_names_json FROM local_metabase_sync_config WHERE metabase_connection_id = ?')
      .get(connectionId) as SyncConfigRow | undefined;
    const selections = this.db
      .prepare(
        `
        SELECT selection_type, metabase_object_id
        FROM local_metabase_selections
        WHERE metabase_connection_id = ?
        ORDER BY selection_type, metabase_object_id
      `,
      )
      .all(connectionId) as SelectionRow[];
    const mappings = this.db
      .prepare(
        `
        SELECT
          metabase_database_id,
          metabase_database_name,
          metabase_engine,
          target_connection_id,
          sync_enabled
        FROM local_metabase_database_mappings
        WHERE metabase_connection_id = ?
          AND metabase_database_name IS NOT NULL
        ORDER BY metabase_database_id
      `,
      )
      .all(connectionId) as MappingRow[];

    return {
      syncMode: config?.sync_mode ?? 'ALL',
      defaultTagNames: config ? parseDefaultTagNames(config.default_tag_names_json) : [],
      selections: selections.map((selection) => ({
        selectionType: selection.selection_type,
        metabaseObjectId: selection.metabase_object_id,
      })),
      mappings: mappings.map((mapping) => ({
        metabaseDatabaseId: mapping.metabase_database_id,
        metabaseDatabaseName: mapping.metabase_database_name,
        metabaseEngine: mapping.metabase_engine,
        targetConnectionId: mapping.target_connection_id,
        syncEnabled: mapping.sync_enabled === 1,
      })),
    };
  }
}
