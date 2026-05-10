import { describe, expect, it, vi } from 'vitest';
import {
  createKtxConnectorCapabilities,
  type KtxScanConnector,
  type KtxScanContext,
  type KtxScanEnrichmentStateSummary,
  type KtxScanInput,
  KtxScanOrchestrator,
  type KtxSchemaSnapshot,
} from './index.js';

function snapshot(): KtxSchemaSnapshot {
  return {
    connectionId: 'warehouse',
    driver: 'postgres',
    extractedAt: '2026-04-29T00:00:00.000Z',
    scope: { schemas: ['public'] },
    metadata: { source: 'test' },
    tables: [
      {
        catalog: null,
        db: 'public',
        name: 'orders',
        kind: 'table',
        comment: 'Orders table',
        estimatedRows: null,
        columns: [
          {
            name: 'id',
            nativeType: 'integer',
            normalizedType: 'integer',
            dimensionType: 'number',
            nullable: false,
            primaryKey: true,
            comment: 'Order id',
          },
        ],
        foreignKeys: [],
      },
    ],
  };
}

function connector(
  capabilities = createKtxConnectorCapabilities({ tableSampling: true, columnSampling: true }),
): KtxScanConnector {
  return {
    id: 'connector-1',
    driver: 'postgres',
    capabilities,
    introspect: vi.fn(async () => snapshot()),
  };
}

function context(): KtxScanContext {
  return {
    runId: 'scan-run-1',
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}

const input: KtxScanInput = {
  connectionId: 'warehouse',
  driver: 'postgres',
  mode: 'structural',
};

describe('KtxScanOrchestrator', () => {
  it('runs structural scans through connector introspection and structural host callback', async () => {
    const scanConnector = connector();
    const scanContext = context();
    const runStructural = vi.fn(async (scanSnapshot: KtxSchemaSnapshot) => ({
      result: { synced: true },
      diffSummary: { tablesAdded: scanSnapshot.tables.length, columnsAdded: 1 },
      structuralSyncStats: { tablesCreated: 1, columnsCreated: 1 },
      artifactPaths: { manifestShards: ['semantic-layer/warehouse/_schema/public.yaml'] },
    }));

    const result = await new KtxScanOrchestrator({
      now: () => new Date('2026-04-29T00:10:00.000Z'),
      syncIdFactory: () => 'sync-1',
    }).run({
      connector: scanConnector,
      input,
      trigger: 'schema_scan',
      context: scanContext,
      runStructural,
    });

    expect(scanConnector.introspect).toHaveBeenCalledWith(input, scanContext);
    expect(runStructural).toHaveBeenCalledWith(snapshot(), scanContext);
    expect(result.snapshot.connectionId).toBe('warehouse');
    expect(result.structural.result).toEqual({ synced: true });
    expect(result.enrichment).toBeNull();
    expect(result.report).toMatchObject({
      connectionId: 'warehouse',
      driver: 'postgres',
      syncId: 'sync-1',
      runId: 'scan-run-1',
      trigger: 'schema_scan',
      mode: 'structural',
      dryRun: false,
      diffSummary: {
        tablesAdded: 1,
        columnsAdded: 1,
      },
      structuralSyncStats: {
        tablesCreated: 1,
        columnsCreated: 1,
      },
      manifestShardsWritten: 1,
      artifactPaths: {
        manifestShards: ['semantic-layer/warehouse/_schema/public.yaml'],
      },
      enrichment: {
        dataDictionary: 'skipped',
        columnDescriptions: 'skipped',
        tableDescriptions: 'skipped',
        embeddings: 'skipped',
        deterministicRelationships: 'skipped',
        llmRelationshipValidation: 'skipped',
        statisticalValidation: 'skipped',
      },
      enrichmentState: {
        resumedStages: [],
        completedStages: [],
        failedStages: [],
      },
      createdAt: '2026-04-29T00:10:00.000Z',
    });
  });

  it('runs enriched scans through structural and enrichment host callbacks', async () => {
    const scanConnector = connector(
      createKtxConnectorCapabilities({
        tableSampling: true,
        columnSampling: true,
        columnStats: true,
        readOnlySql: true,
      }),
    );
    const scanContext = context();

    const result = await new KtxScanOrchestrator({ syncIdFactory: () => 'sync-2' }).run({
      connector: scanConnector,
      input: { ...input, mode: 'enriched', detectRelationships: true },
      trigger: 'schema_scan',
      context: scanContext,
      runStructural: vi.fn(async () => ({
        result: { schemaId: 'schema-1' },
        structuralSyncStats: { tablesCreated: 1 },
      })),
      runEnrichment: vi.fn(async () => ({
        result: { enriched: true },
        enrichment: {
          dataDictionary: 'completed',
          columnDescriptions: 'completed',
          tableDescriptions: 'completed',
          embeddings: 'completed',
          deterministicRelationships: 'completed',
          statisticalValidation: 'completed',
        } as const,
        relationships: { accepted: 2, rejected: 1 },
      })),
    });

    expect(result.enrichment?.result).toEqual({ enriched: true });
    expect(result.report.enrichment.columnDescriptions).toBe('completed');
    expect(result.report.relationships).toEqual({ accepted: 2, review: 0, rejected: 1, skipped: 0 });
    expect(result.report.capabilityGaps).toEqual([]);
    expect(result.report.warnings).toEqual([]);
  });

  it('reports host enrichment state summaries from enriched scan phases', async () => {
    const scanConnector = connector(
      createKtxConnectorCapabilities({
        tableSampling: true,
        columnSampling: true,
        columnStats: true,
        readOnlySql: true,
      }),
    );
    const enrichmentState: Partial<KtxScanEnrichmentStateSummary> = {
      resumedStages: ['relationships', 'descriptions', 'descriptions'],
      completedStages: ['embeddings', 'descriptions', 'relationships'],
      failedStages: [],
    };

    const result = await new KtxScanOrchestrator({ syncIdFactory: () => 'sync-state' }).run({
      connector: scanConnector,
      input: { ...input, mode: 'enriched', detectRelationships: true },
      trigger: 'schema_scan',
      context: context(),
      runStructural: vi.fn(async () => ({ result: { synced: true } })),
      runEnrichment: vi.fn(async () => ({
        result: { enriched: true },
        enrichmentState,
      })),
    });

    expect(result.report.enrichmentState).toEqual({
      resumedStages: ['descriptions', 'relationships'],
      completedStages: ['descriptions', 'embeddings', 'relationships'],
      failedStages: [],
    });
  });

  it('records recoverable warnings for missing optional capabilities during enriched scans', async () => {
    const result = await new KtxScanOrchestrator({ syncIdFactory: () => 'sync-3' }).run({
      connector: connector(createKtxConnectorCapabilities()),
      input: { ...input, mode: 'enriched', detectRelationships: true },
      trigger: 'schema_scan',
      context: context(),
      runStructural: vi.fn(async () => ({ result: {} })),
      runEnrichment: vi.fn(async () => ({ result: {} })),
    });

    expect(result.report.capabilityGaps).toEqual(['tableSampling', 'columnSampling', 'columnStats', 'readOnlySql']);
    expect(result.report.warnings.map((warning) => warning.code)).toEqual([
      'connector_capability_missing',
      'connector_capability_missing',
      'connector_capability_missing',
      'connector_capability_missing',
    ]);
    expect(result.report.warnings.every((warning) => warning.recoverable)).toBe(true);
  });

  it('redacts structural and enrichment warning metadata before returning reports', async () => {
    const result = await new KtxScanOrchestrator({ syncIdFactory: () => 'sync-redacted' }).run({
      connector: connector(
        createKtxConnectorCapabilities({
          tableSampling: true,
          columnSampling: true,
          columnStats: true,
          readOnlySql: true,
        }),
      ),
      input: { ...input, mode: 'enriched' },
      trigger: 'schema_scan',
      context: context(),
      runStructural: vi.fn(async () => ({
        result: {},
        warnings: [
          {
            code: 'sampling_failed',
            message: 'structural warning',
            recoverable: true,
            metadata: {
              url: 'postgres://reader:secret@example.test/db', // pragma: allowlist secret
              table: 'orders',
            },
          } as const,
        ],
      })),
      runEnrichment: vi.fn(async () => ({
        result: {},
        warnings: [
          {
            code: 'embedding_unavailable',
            message: 'enrichment warning',
            recoverable: true,
            metadata: {
              nested: {
                api_key: 'sk_test_123', // pragma: allowlist secret
                schema: 'public',
              },
            },
          } as const,
        ],
      })),
    });

    expect(result.report.warnings).toEqual([
      {
        code: 'sampling_failed',
        message: 'structural warning',
        recoverable: true,
        metadata: {
          url: '<redacted>',
          table: 'orders',
        },
      },
      {
        code: 'embedding_unavailable',
        message: 'enrichment warning',
        recoverable: true,
        metadata: {
          nested: {
            api_key: '<redacted>',
            schema: 'public',
          },
        },
      },
    ]);
  });

  it('keeps structural results when the enrichment phase fails after structural sync', async () => {
    const scanConnector = connector(
      createKtxConnectorCapabilities({
        tableSampling: true,
        columnSampling: true,
        columnStats: true,
        readOnlySql: true,
      }),
    );
    const runStructural = vi.fn(async () => ({
      result: { synced: true },
      artifactPaths: {
        rawSourcesDir: 'raw-sources/warehouse/live-database/sync-failed-enrichment',
        manifestShards: ['semantic-layer/warehouse/_schema/public.yaml'],
      },
      manifestShardsWritten: 1,
    }));
    const runEnrichment = vi.fn(async () => {
      throw new Error('AI Gateway timed out');
    });

    const result = await new KtxScanOrchestrator({
      now: () => new Date('2026-04-29T18:00:00.000Z'),
      syncIdFactory: () => 'sync-failed-enrichment',
    }).run({
      connector: scanConnector,
      input: { ...input, mode: 'enriched', detectRelationships: true },
      trigger: 'schema_scan',
      context: context(),
      runStructural,
      runEnrichment,
    });

    expect(result.structural.result).toEqual({ synced: true });
    expect(result.enrichment).toBeNull();
    expect(result.report.artifactPaths.manifestShards).toEqual(['semantic-layer/warehouse/_schema/public.yaml']);
    expect(result.report.manifestShardsWritten).toBe(1);
    expect(result.report.enrichment).toEqual({
      dataDictionary: 'failed',
      tableDescriptions: 'failed',
      columnDescriptions: 'failed',
      embeddings: 'failed',
      deterministicRelationships: 'failed',
      llmRelationshipValidation: 'failed',
      statisticalValidation: 'failed',
    });
    expect(result.report.warnings).toEqual([
      {
        code: 'enrichment_failed',
        message: 'KTX scan enrichment failed after structural scan completed: AI Gateway timed out',
        recoverable: true,
        metadata: {
          mode: 'enriched',
          detectRelationships: true,
        },
      },
    ]);
  });

  it('marks dry-run reports without changing host callback behavior', async () => {
    const runStructural = vi.fn(async () => ({ result: { planned: true }, manifestShardsWritten: 0 }));

    const result = await new KtxScanOrchestrator({ syncIdFactory: () => 'sync-4' }).run({
      connector: connector(),
      input: { ...input, dryRun: true },
      trigger: 'cli',
      context: context(),
      runStructural,
    });

    expect(runStructural).toHaveBeenCalledTimes(1);
    expect(result.report.dryRun).toBe(true);
    expect(result.report.trigger).toBe('cli');
  });
});
