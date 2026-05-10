import { resolveKtxConfigReference } from '@ktx/context/core';
import {
  createMemoryFlowLiveBuffer,
  ingestReportToMemoryFlowReplay,
  runLocalIngest,
  type IngestReportSnapshot,
  type LocalIngestResult,
  type MemoryFlowReplayInput,
  type RunLocalIngestOptions,
} from '@ktx/context/ingest';
import { loadKtxProject, type KtxLocalProject } from '@ktx/context/project';
import { runLocalScan, type LocalScanRunResult } from '@ktx/context/scan';
import { DEMO_ADAPTER, DEMO_CONNECTION_ID, DEMO_FULL_JOB_ID, ensureDemoProject } from './demo-assets.js';
import { runDemoScan } from './demo-scan.js';
import { createKtxCliLocalIngestAdapters } from './local-adapters.js';
import { formatNextStepLines } from './next-steps.js';

interface DemoFullOptions {
  projectDir: string;
  env?: NodeJS.ProcessEnv;
  runLocalScan?: typeof runLocalScan;
  runLocalIngest?: typeof runLocalIngest;
  onMemoryFlowChange?: (snapshot: MemoryFlowReplayInput) => void;
}

export interface DemoFullResult {
  project: KtxLocalProject;
  scan: LocalScanRunResult;
  ingest: LocalIngestResult;
  report: IngestReportSnapshot;
  replay: MemoryFlowReplayInput;
}

type FullDemoCredentialStatus =
  | { status: 'ready' }
  | { status: 'missing-anthropic-key' }
  | { status: 'unsupported-provider'; provider: string };

async function ensureDemoProjectForReuse(projectDir: string): Promise<void> {
  await ensureDemoProject({ projectDir, force: false }).catch((error) => {
    if (error instanceof Error && error.message.includes('Demo project already exists')) {
      return;
    }
    throw error;
  });
}

function savedCounts(report: IngestReportSnapshot): { wikiCount: number; slCount: number } {
  const actions = report.body.workUnits.flatMap((workUnit) => workUnit.actions);
  return {
    wikiCount: actions.filter((action) => action.target === 'wiki').length,
    slCount: actions.filter((action) => action.target === 'sl').length,
  };
}

export function fullDemoCredentialStatus(
  project: KtxLocalProject,
  env: NodeJS.ProcessEnv = process.env,
): FullDemoCredentialStatus {
  const llm = project.config.llm;
  if (llm.provider.backend === 'none') {
    return { status: 'unsupported-provider', provider: llm.provider.backend };
  }

  if (llm.provider.backend === 'anthropic' && !resolveKtxConfigReference(llm.provider.anthropic?.api_key, env)) {
    return { status: 'missing-anthropic-key' };
  }

  return { status: 'ready' };
}

export function assertFullDemoCredentials(project: KtxLocalProject, env: NodeJS.ProcessEnv = process.env): void {
  const llm = project.config.llm;
  const status = fullDemoCredentialStatus(project, env);
  if (status.status === 'ready') {
    return;
  }

  if (status.status === 'unsupported-provider') {
    throw new Error(
      'ktx setup demo --mode full requires llm.provider.backend: anthropic, vertex, or gateway. Run `ktx setup demo init --force --no-input` to recreate the demo config, or run `ktx setup demo --mode seeded --no-input` without credentials.',
    );
  }

  if (llm.provider.backend === 'anthropic') {
    throw new Error(
      'ktx setup demo --mode full needs ANTHROPIC_API_KEY. Export ANTHROPIC_API_KEY and rerun `ktx setup demo --mode full --no-input`, or run `ktx setup demo --mode seeded --no-input` without credentials.',
    );
  }
}

export function buildFullDemoReplay(report: IngestReportSnapshot): MemoryFlowReplayInput {
  return ingestReportToMemoryFlowReplay(report, { provenanceRowCount: report.body.provenanceRows.length });
}

function initialFullReplay(projectDir: string): MemoryFlowReplayInput {
  return {
    runId: DEMO_FULL_JOB_ID,
    connectionId: DEMO_CONNECTION_ID,
    adapter: DEMO_ADAPTER,
    status: 'running',
    sourceDir: `${projectDir}/raw-sources/${DEMO_CONNECTION_ID}/${DEMO_ADAPTER}`,
    syncId: 'pending',
    errors: [],
    events: [],
    plannedWorkUnits: [],
    details: { actions: [], provenance: [], transcripts: [] },
  };
}

export async function runDemoFull(options: DemoFullOptions): Promise<DemoFullResult> {
  await ensureDemoProjectForReuse(options.projectDir);
  const project = await loadKtxProject({ projectDir: options.projectDir });
  assertFullDemoCredentials(project, options.env);

  const { result: scan } = await runDemoScan({
    projectDir: project.projectDir,
    jobId: 'demo-full-scan',
    ...(options.runLocalScan ? { runLocalScan: options.runLocalScan } : {}),
  });

  const memoryFlow = options.onMemoryFlowChange
    ? createMemoryFlowLiveBuffer(initialFullReplay(project.projectDir), { onChange: options.onMemoryFlowChange })
    : undefined;
  const executeLocalIngest = options.runLocalIngest ?? runLocalIngest;
  const ingest = await executeLocalIngest({
    project,
    adapters: createKtxCliLocalIngestAdapters(project),
    adapter: DEMO_ADAPTER,
    connectionId: DEMO_CONNECTION_ID,
    trigger: 'manual_resync',
    jobId: DEMO_FULL_JOB_ID,
    ...(memoryFlow ? { memoryFlow } : {}),
  } satisfies RunLocalIngestOptions);

  return {
    project,
    scan,
    ingest,
    report: ingest.report,
    replay: buildFullDemoReplay(ingest.report),
  };
}

export function formatFullDemoSummary(report: IngestReportSnapshot): string {
  const counts = savedCounts(report);
  return [
    'Full demo ingest: done',
    `Report: ${report.id}`,
    `Run: ${report.runId}`,
    `Job: ${report.jobId}`,
    `Sync: ${report.body.syncId}`,
    `Saved memory: ${counts.wikiCount} wiki, ${counts.slCount} semantic layer`,
    `Provenance rows: ${report.body.provenanceRows.length}`,
    'Next: ktx setup demo inspect',
    '  Shows the files, semantic-layer sources, and memory KTX just produced.',
    'Next: ktx setup demo replay',
    '  Replays the same visual story without calling the LLM again.',
    '',
  ].join('\n');
}

const ADAPTER_PREFIXES = ['live_database_', 'metabase_', 'looker_', 'lookml_', 'metricflow_', 'notion_', 'historic_sql_', 'dbt_descriptions_'];

function humanizeUnitKeyForReport(unitKey: string): string {
  let key = unitKey.replace(/-/g, '_');
  for (const prefix of ADAPTER_PREFIXES) {
    if (key.startsWith(prefix)) { key = key.slice(prefix.length); break; }
  }
  return key.replace(/_/g, ' ');
}

export function formatCleanDemoSummary(report: IngestReportSnapshot, projectDir: string): string {
  const counts = savedCounts(report);
  const workUnits = report.body.workUnits;
  const conflictCount = report.body.conflictsResolved.length;
  const areasAnalyzed = workUnits.filter((wu) => wu.actions.length > 0).length;

  const lines: string[] = ['', '★ KTX finished ingesting your data', ''];

  if (areasAnalyzed > 0) {
    lines.push(`  ✓ Analyzed ${areasAnalyzed} business area${areasAnalyzed === 1 ? '' : 's'}`);
  }
  if (!report.body.reconciliationSkipped) {
    lines.push(`  ✓ Reconciled — ${conflictCount > 0 ? `${conflictCount} conflict${conflictCount === 1 ? '' : 's'} resolved` : 'no conflicts'}`);
  }
  lines.push('');

  if (counts.slCount > 0 || counts.wikiCount > 0) {
    lines.push('  KTX created:');
    if (counts.slCount > 0) lines.push(`    📊 ${counts.slCount} query definition${counts.slCount === 1 ? '' : 's'} — so agents can write accurate SQL for your data`);
    if (counts.wikiCount > 0) lines.push(`    📝 ${counts.wikiCount} knowledge page${counts.wikiCount === 1 ? '' : 's'} — so agents understand your business context`);
    lines.push('');
  }

  const memoryFlow = report.body.memoryFlow;
  if (memoryFlow) {
    for (const detail of memoryFlow.details.actions) {
      if (!detail.summary) continue;
      const icon = detail.target === 'sl' ? '📊' : '📝';
      lines.push(`    ${icon} ${detail.summary}`);
    }
  }

  lines.push('');
  lines.push('  What to do next:');
  lines.push(...formatNextStepLines());
  lines.push('');
  lines.push(`  Your KTX project files are at: ${projectDir}`);
  lines.push('');

  return lines.join('\n');
}
