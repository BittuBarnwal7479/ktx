import { redactKtxScanReport } from './credentials.js';
import { completedKtxScanEnrichmentStateSummary, summarizeKtxScanEnrichmentState } from './enrichment-state.js';
import {
  failedKtxScanEnrichmentSummary,
  ktxScanErrorMessage,
  skippedKtxScanEnrichmentSummary,
} from './enrichment-summary.js';
import type {
  KtxConnectorCapabilities,
  KtxScanArtifactPaths,
  KtxScanConnector,
  KtxScanContext,
  KtxScanDiffSummary,
  KtxScanEnrichmentSummary,
  KtxScanEnrichmentStateSummary,
  KtxScanInput,
  KtxScanRelationshipSummary,
  KtxScanReport,
  KtxScanTrigger,
  KtxScanWarning,
  KtxSchemaSnapshot,
  KtxStructuralSyncStats,
} from './types.js';

type CapabilityGap = keyof Omit<KtxConnectorCapabilities, 'structuralIntrospection'>;

export interface KtxStructuralScanPhaseResult<TResult = unknown> {
  result: TResult;
  diffSummary?: Partial<KtxScanDiffSummary>;
  structuralSyncStats?: Partial<KtxStructuralSyncStats>;
  manifestShardsWritten?: number;
  artifactPaths?: Partial<KtxScanArtifactPaths>;
  relationships?: Partial<KtxScanRelationshipSummary>;
  warnings?: KtxScanWarning[];
}

export interface KtxEnrichmentScanPhaseResult<TResult = unknown> {
  result: TResult;
  enrichment?: Partial<KtxScanEnrichmentSummary>;
  enrichmentState?: Partial<KtxScanEnrichmentStateSummary>;
  manifestShardsWritten?: number;
  artifactPaths?: Partial<KtxScanArtifactPaths>;
  relationships?: Partial<KtxScanRelationshipSummary>;
  warnings?: KtxScanWarning[];
}

export interface KtxScanOrchestratorRunInput<TStructuralResult = unknown, TEnrichmentResult = unknown> {
  connector: KtxScanConnector;
  input: KtxScanInput;
  trigger: KtxScanTrigger;
  context: KtxScanContext;
  syncId?: string;
  runStructural: (
    snapshot: KtxSchemaSnapshot,
    context: KtxScanContext,
  ) => Promise<KtxStructuralScanPhaseResult<TStructuralResult>>;
  runEnrichment?: (
    snapshot: KtxSchemaSnapshot,
    structural: KtxStructuralScanPhaseResult<TStructuralResult>,
    context: KtxScanContext,
  ) => Promise<KtxEnrichmentScanPhaseResult<TEnrichmentResult>>;
}

export interface KtxScanOrchestratorRunResult<TStructuralResult = unknown, TEnrichmentResult = unknown> {
  snapshot: KtxSchemaSnapshot;
  structural: KtxStructuralScanPhaseResult<TStructuralResult>;
  enrichment: KtxEnrichmentScanPhaseResult<TEnrichmentResult> | null;
  report: KtxScanReport;
}

export interface KtxScanOrchestratorOptions {
  now?: () => Date;
  syncIdFactory?: (input: KtxScanInput, context: KtxScanContext) => string;
}

const emptyDiffSummary: KtxScanDiffSummary = {
  tablesAdded: 0,
  tablesModified: 0,
  tablesDeleted: 0,
  tablesUnchanged: 0,
  columnsAdded: 0,
  columnsModified: 0,
  columnsDeleted: 0,
};

const emptyStructuralSyncStats: KtxStructuralSyncStats = {
  tablesCreated: 0,
  tablesUpdated: 0,
  tablesDeleted: 0,
  columnsCreated: 0,
  columnsUpdated: 0,
  columnsDeleted: 0,
};

const emptyArtifactPaths: KtxScanArtifactPaths = {
  rawSourcesDir: null,
  reportPath: null,
  manifestShards: [],
  enrichmentArtifacts: [],
};

function mergeDiffSummary(input?: Partial<KtxScanDiffSummary>): KtxScanDiffSummary {
  return { ...emptyDiffSummary, ...input };
}

function mergeStructuralSyncStats(input?: Partial<KtxStructuralSyncStats>): KtxStructuralSyncStats {
  return { ...emptyStructuralSyncStats, ...input };
}

function mergeEnrichmentSummary(input?: Partial<KtxScanEnrichmentSummary>): KtxScanEnrichmentSummary {
  return { ...skippedKtxScanEnrichmentSummary, ...input };
}

function mergeEnrichmentState(input?: Partial<KtxScanEnrichmentStateSummary>): KtxScanEnrichmentStateSummary {
  if (!input) {
    return completedKtxScanEnrichmentStateSummary();
  }

  return summarizeKtxScanEnrichmentState({
    resumedStages: input.resumedStages ?? [],
    completedStages: input.completedStages ?? [],
    failedStages: input.failedStages ?? [],
  });
}

function mergeArtifactPaths(
  structural?: Partial<KtxScanArtifactPaths>,
  enrichment?: Partial<KtxScanArtifactPaths>,
): KtxScanArtifactPaths {
  return {
    ...emptyArtifactPaths,
    ...structural,
    ...enrichment,
    manifestShards: [...(structural?.manifestShards ?? []), ...(enrichment?.manifestShards ?? [])],
    enrichmentArtifacts: [...(structural?.enrichmentArtifacts ?? []), ...(enrichment?.enrichmentArtifacts ?? [])],
  };
}

function mergeRelationshipSummary(
  structural?: Partial<KtxScanRelationshipSummary>,
  enrichment?: Partial<KtxScanRelationshipSummary>,
): KtxScanRelationshipSummary {
  return {
    accepted: (structural?.accepted ?? 0) + (enrichment?.accepted ?? 0),
    review: (structural?.review ?? 0) + (enrichment?.review ?? 0),
    rejected: (structural?.rejected ?? 0) + (enrichment?.rejected ?? 0),
    skipped: (structural?.skipped ?? 0) + (enrichment?.skipped ?? 0),
  };
}

function manifestShardsWritten(phase: {
  manifestShardsWritten?: number;
  artifactPaths?: Partial<KtxScanArtifactPaths>;
}): number {
  return phase.manifestShardsWritten ?? phase.artifactPaths?.manifestShards?.length ?? 0;
}

function requiredCapabilities(mode: KtxScanInput['mode'], detectRelationships: boolean | undefined): CapabilityGap[] {
  const required = new Set<CapabilityGap>();

  if (mode === 'enriched') {
    required.add('tableSampling');
    required.add('columnSampling');
    required.add('columnStats');
    required.add('readOnlySql');
  }

  if (mode === 'relationships' || detectRelationships) {
    required.add('columnStats');
    required.add('readOnlySql');
  }

  return [...required];
}

function capabilityGaps(capabilities: KtxConnectorCapabilities, input: KtxScanInput): CapabilityGap[] {
  return requiredCapabilities(input.mode ?? 'structural', input.detectRelationships).filter(
    (capability) => !capabilities[capability],
  );
}

function warningsForCapabilityGaps(gaps: CapabilityGap[]): KtxScanWarning[] {
  return gaps.map((gap) => ({
    code: 'connector_capability_missing',
    message: `KTX scan connector is missing optional capability: ${gap}`,
    recoverable: true,
    metadata: { capability: gap },
  }));
}

function assertNotAborted(context: KtxScanContext): void {
  if (context.signal?.aborted) {
    throw new Error('KTX scan aborted');
  }
}

export class KtxScanOrchestrator {
  private readonly now: () => Date;
  private readonly syncIdFactory: (input: KtxScanInput, context: KtxScanContext) => string;

  constructor(options: KtxScanOrchestratorOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.syncIdFactory = options.syncIdFactory ?? ((_, context) => context.runId);
  }

  async run<TStructuralResult = unknown, TEnrichmentResult = unknown>(
    input: KtxScanOrchestratorRunInput<TStructuralResult, TEnrichmentResult>,
  ): Promise<KtxScanOrchestratorRunResult<TStructuralResult, TEnrichmentResult>> {
    const mode = input.input.mode ?? 'structural';
    const syncId = input.syncId ?? this.syncIdFactory(input.input, input.context);
    const gaps = capabilityGaps(input.connector.capabilities, input.input);
    const warnings = warningsForCapabilityGaps(gaps);

    input.context.logger?.info('Starting KTX scan', {
      connectionId: input.input.connectionId,
      connectorId: input.connector.id,
      mode,
      trigger: input.trigger,
    });

    assertNotAborted(input.context);
    const snapshot = await input.connector.introspect(input.input, input.context);

    assertNotAborted(input.context);
    const structural = await input.runStructural(snapshot, input.context);

    let enrichment: KtxEnrichmentScanPhaseResult<TEnrichmentResult> | null = null;
    let failedEnrichment: KtxScanEnrichmentSummary | null = null;
    if (mode !== 'structural' || input.input.detectRelationships) {
      if (input.runEnrichment) {
        assertNotAborted(input.context);
        try {
          enrichment = await input.runEnrichment(snapshot, structural, input.context);
        } catch (error) {
          const message = ktxScanErrorMessage(error);
          failedEnrichment = failedKtxScanEnrichmentSummary(mode, input.input.detectRelationships ?? false);
          warnings.push({
            code: 'enrichment_failed',
            message: `KTX scan enrichment failed after structural scan completed: ${message}`,
            recoverable: true,
            metadata: { mode, detectRelationships: input.input.detectRelationships ?? false },
          });
          input.context.logger?.warn('KTX scan enrichment failed after structural scan completed', {
            connectionId: input.input.connectionId,
            runId: input.context.runId,
            mode,
            error: message,
          });
        }
      } else {
        failedEnrichment = failedKtxScanEnrichmentSummary(mode, input.input.detectRelationships ?? false);
        warnings.push({
          code: 'connector_capability_missing',
          message: 'KTX scan requested enrichment or relationship detection, but no enrichment phase was provided',
          recoverable: true,
          metadata: { mode, detectRelationships: input.input.detectRelationships ?? false },
        });
      }
    }

    const manifestShardCount = manifestShardsWritten(structural) + (enrichment ? manifestShardsWritten(enrichment) : 0);

    const report: KtxScanReport = redactKtxScanReport({
      connectionId: input.input.connectionId,
      driver: input.input.driver,
      syncId,
      runId: input.context.runId,
      trigger: input.trigger,
      mode,
      dryRun: input.input.dryRun ?? false,
      artifactPaths: mergeArtifactPaths(structural.artifactPaths, enrichment?.artifactPaths),
      diffSummary: mergeDiffSummary(structural.diffSummary),
      manifestShardsWritten: manifestShardCount,
      structuralSyncStats: mergeStructuralSyncStats(structural.structuralSyncStats),
      enrichment: mergeEnrichmentSummary(enrichment?.enrichment ?? failedEnrichment ?? undefined),
      capabilityGaps: gaps,
      warnings: [...warnings, ...(structural.warnings ?? []), ...(enrichment?.warnings ?? [])],
      relationships: mergeRelationshipSummary(structural.relationships, enrichment?.relationships),
      enrichmentState: mergeEnrichmentState(enrichment?.enrichmentState),
      createdAt: this.now().toISOString(),
    });

    input.context.logger?.info('Completed KTX scan', {
      connectionId: report.connectionId,
      runId: report.runId,
      syncId: report.syncId,
      warnings: report.warnings.length,
    });

    return {
      snapshot,
      structural,
      enrichment,
      report,
    };
  }
}
