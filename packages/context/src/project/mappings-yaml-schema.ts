import * as z from 'zod';
import type { KtxProjectConnectionConfig } from './config.js';

const metabaseSyncModeSchema = z.enum(['ALL', 'ONLY', 'EXCEPT']);
const positiveIntegerValueSchema = z.number().int().positive();
const stringTargetSchema = z.string().min(1).nullable();

const metabaseSelectionsSchema = z
  .object({
    collections: z.array(positiveIntegerValueSchema).default([]),
    items: z.array(positiveIntegerValueSchema).default([]),
  });

const metabaseMappingsSchema = z
  .object({
    databaseMappings: z.record(z.string(), stringTargetSchema).default({}),
    syncEnabled: z.record(z.string(), z.boolean()).default({}),
    syncMode: metabaseSyncModeSchema.default('ALL'),
    selections: metabaseSelectionsSchema.default({ collections: [], items: [] }),
    defaultTagNames: z.array(z.string().min(1)).default([]),
  });

const lookerMappingsSchema = z
  .object({
    connectionMappings: z.record(z.string().min(1), stringTargetSchema).default({}),
  });

const lookmlMappingsSchema = z
  .object({
    expectedLookerConnectionName: z.string().min(1).nullable().default(null),
  });

export type MetabaseMappingBootstrap = {
  adapter: 'metabase';
  connectionId: string;
  databaseMappings: Record<string, string | null>;
  syncEnabled: Record<string, boolean>;
  syncMode: z.infer<typeof metabaseSyncModeSchema>;
  selections: { collections: number[]; items: number[] };
  defaultTagNames: string[];
};

export type LookerMappingBootstrap = {
  adapter: 'looker';
  connectionId: string;
  connectionMappings: Record<string, string | null>;
};

export type LookmlMappingBootstrap = {
  adapter: 'lookml';
  connectionId: string;
  expectedLookerConnectionName: string | null;
};

export type ConnectionMappingBootstrap = MetabaseMappingBootstrap | LookerMappingBootstrap | LookmlMappingBootstrap;

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function assertPositiveIntegerKeys(field: string, record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) {
    if (!/^[1-9]\d*$/.test(key)) {
      throw new Error(`${field} key "${key}" must be a positive integer string`);
    }
  }
}

function driverOf(connection: KtxProjectConnectionConfig): string {
  return String(connection.driver ?? '').toLowerCase();
}

export function parseMetabaseMappingBootstrap(
  connectionId: string,
  connection: KtxProjectConnectionConfig,
): MetabaseMappingBootstrap {
  const rawMappings = recordValue(connection.mappings);
  assertPositiveIntegerKeys('databaseMappings', recordValue(rawMappings.databaseMappings));
  assertPositiveIntegerKeys('syncEnabled', recordValue(rawMappings.syncEnabled));
  const parsed = metabaseMappingsSchema.parse(rawMappings);
  return {
    adapter: 'metabase',
    connectionId,
    databaseMappings: parsed.databaseMappings,
    syncEnabled: parsed.syncEnabled,
    syncMode: parsed.syncMode,
    selections: parsed.selections,
    defaultTagNames: parsed.defaultTagNames,
  };
}

export function parseLookerMappingBootstrap(
  connectionId: string,
  connection: KtxProjectConnectionConfig,
): LookerMappingBootstrap {
  const parsed = lookerMappingsSchema.parse(recordValue(connection.mappings));
  return {
    adapter: 'looker',
    connectionId,
    connectionMappings: parsed.connectionMappings,
  };
}

export function parseLookmlMappingBootstrap(
  connectionId: string,
  connection: KtxProjectConnectionConfig,
): LookmlMappingBootstrap {
  const parsed = lookmlMappingsSchema.parse(recordValue(connection.mappings));
  return {
    adapter: 'lookml',
    connectionId,
    expectedLookerConnectionName: parsed.expectedLookerConnectionName,
  };
}

export function parseConnectionMappingBootstrap(
  connectionId: string,
  connection: KtxProjectConnectionConfig,
): ConnectionMappingBootstrap | null {
  if (!connection.mappings || typeof connection.mappings !== 'object' || Array.isArray(connection.mappings)) {
    return null;
  }

  const driver = driverOf(connection);
  if (driver === 'metabase') {
    return parseMetabaseMappingBootstrap(connectionId, connection);
  }
  if (driver === 'looker') {
    return parseLookerMappingBootstrap(connectionId, connection);
  }
  if (driver === 'lookml') {
    return parseLookmlMappingBootstrap(connectionId, connection);
  }
  return null;
}
