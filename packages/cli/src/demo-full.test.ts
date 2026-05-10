import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IngestReportSnapshot, LocalIngestResult, RunLocalIngestOptions } from '@ktx/context/ingest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_ADAPTER, DEMO_CONNECTION_ID, DEMO_FULL_JOB_ID, ensureDemoProject } from './demo-assets.js';
import {
  assertFullDemoCredentials,
  buildFullDemoReplay,
  formatFullDemoSummary,
  fullDemoCredentialStatus,
  runDemoFull,
} from './demo-full.js';

function fakeFullReport(): IngestReportSnapshot {
  return {
    id: 'report-full',
    runId: 'run-full',
    jobId: DEMO_FULL_JOB_ID,
    connectionId: DEMO_CONNECTION_ID,
    sourceKey: DEMO_ADAPTER,
    createdAt: '2026-05-01T00:00:00.000Z',
    body: {
      syncId: 'sync-full',
      diffSummary: { added: 7, modified: 0, deleted: 0, unchanged: 0 },
      commitSha: null,
      workUnits: [
        {
          unitKey: 'accounts',
          rawFiles: ['accounts.schema.json'],
          status: 'success',
          actions: [
            { target: 'wiki', type: 'created', key: 'knowledge/accounts.md', detail: 'account lifecycle context' },
            { target: 'sl', type: 'created', key: 'orbit_demo.accounts', detail: 'accounts semantic source' },
          ],
          touchedSlSources: [{ connectionId: 'orbit_demo', sourceName: 'orbit_demo.accounts' }],
        },
      ],
      failedWorkUnits: [],
      reconciliationSkipped: false,
      conflictsResolved: [],
      evictionsApplied: [],
      unmappedFallbacks: [],
      evictionInputs: [],
      unresolvedCards: [],
      supersededBy: null,
      overrideOf: null,
      provenanceRows: [
        {
          rawPath: 'accounts.schema.json',
          artifactKind: 'wiki',
          artifactKey: 'knowledge/accounts.md',
          actionType: 'wiki_written',
        },
        {
          rawPath: 'accounts.schema.json',
          artifactKind: 'sl',
          artifactKey: 'orbit_demo.accounts',
          actionType: 'source_created',
        },
      ],
      toolTranscripts: [],
    },
  };
}

describe('full demo helpers', () => {
  let tempDir: string;
  let projectDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-demo-full-'));
    projectDir = join(tempDir, 'demo');
    await ensureDemoProject({ projectDir, force: false });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('fails full mode with exact Anthropic env guidance when the key is missing', async () => {
    const project = await import('@ktx/context/project').then((mod) => mod.loadKtxProject({ projectDir }));

    expect(() => assertFullDemoCredentials(project, {})).toThrow(
      'ktx setup demo --mode full needs ANTHROPIC_API_KEY. Export ANTHROPIC_API_KEY and rerun `ktx setup demo --mode full --no-input`, or run `ktx setup demo --mode seeded --no-input` without credentials.',
    );
  });

  it('respects an existing gateway provider project for full mode', async () => {
    await writeFile(
      join(projectDir, 'ktx.yaml'),
      [
        'project: ktx-demo-orbit',
        'connections:',
        '  orbit_demo:',
        '    driver: sqlite',
        `    path: ${JSON.stringify(join(projectDir, 'demo.db'))}`,
        'llm:',
        '  provider:',
        '    backend: gateway',
        '  models:',
        '    default: anthropic/claude-sonnet-4-6',
        'ingest:',
        '  adapters:',
        '    - live-database',
        '  embeddings:',
        '    backend: none',
        '',
      ].join('\n'),
      'utf-8',
    );
    const project = await import('@ktx/context/project').then((mod) => mod.loadKtxProject({ projectDir }));

    expect(() => assertFullDemoCredentials(project, {})).not.toThrow();
    expect(fullDemoCredentialStatus(project, {})).toEqual({ status: 'ready' });
  });

  it('reports full-demo credential status without throwing', async () => {
    const project = await import('@ktx/context/project').then((mod) => mod.loadKtxProject({ projectDir }));

    expect(fullDemoCredentialStatus(project, {})).toEqual({ status: 'missing-anthropic-key' });
    expect(fullDemoCredentialStatus(project, { ANTHROPIC_API_KEY: 'sk-ant-test' })).toEqual({ status: 'ready' }); // pragma: allowlist secret

    await writeFile(
      join(projectDir, 'ktx.yaml'),
      [
        'project: ktx-demo-orbit',
        'connections:',
        '  orbit_demo:',
        '    driver: sqlite',
        `    path: ${JSON.stringify(join(projectDir, 'demo.db'))}`,
        'ingest:',
        '  adapters:',
        '    - live-database',
        '',
      ].join('\n'),
      'utf-8',
    );
    const disabledProject = await import('@ktx/context/project').then((mod) => mod.loadKtxProject({ projectDir }));
    expect(fullDemoCredentialStatus(disabledProject, {})).toEqual({ status: 'unsupported-provider', provider: 'none' });
  });

  it('runs scan first and then full ingest with the canonical demo connection', async () => {
    const report = fakeFullReport();
    const runLocalScan = vi.fn().mockResolvedValue({
      report: {
        runId: 'scan-run',
        connectionId: DEMO_CONNECTION_ID,
        driver: 'sqlite',
        mode: 'structural',
        syncId: 'sync-scan',
        diffSummary: { tablesAdded: 7, tablesModified: 0, tablesDeleted: 0, tablesUnchanged: 0 },
        artifactPaths: { rawSourcesDir: 'raw-sources/orbit_demo/live-database/sync-scan', manifestShards: [], reportPath: 'scan-report.json' },
      },
    });
    const runLocalIngest = vi.fn(async (options: RunLocalIngestOptions): Promise<LocalIngestResult> => {
      expect(options.adapter).toBe(DEMO_ADAPTER);
      expect(options.connectionId).toBe(DEMO_CONNECTION_ID);
      expect(options.jobId).toBe(DEMO_FULL_JOB_ID);
      expect(options.memoryFlow?.snapshot()).toMatchObject({ runId: DEMO_FULL_JOB_ID, status: 'running' });
      options.memoryFlow?.emit({ type: 'source_acquired', adapter: DEMO_ADAPTER, trigger: 'demo_full', fileCount: 7 });
      return { result: { ok: true } as never, report };
    });
    const snapshots: unknown[] = [];

    const result = await runDemoFull({
      projectDir,
      env: { ANTHROPIC_API_KEY: 'sk-ant-test' }, // pragma: allowlist secret
      runLocalScan,
      runLocalIngest,
      onMemoryFlowChange: (snapshot) => snapshots.push(snapshot),
    });

    expect(runLocalScan).toHaveBeenCalledTimes(1);
    expect(runLocalIngest).toHaveBeenCalledTimes(1);
    expect(result.report).toBe(report);
    expect(result.replay.runId).toBe('run-full');
    expect(snapshots).toHaveLength(1);
  });

  it('builds replay and plain summary from the full report', () => {
    const report = fakeFullReport();
    const replay = buildFullDemoReplay(report);
    const summary = formatFullDemoSummary(report);

    expect(replay).toMatchObject({
      runId: 'run-full',
      connectionId: DEMO_CONNECTION_ID,
      adapter: DEMO_ADAPTER,
      status: 'done',
    });
    expect(summary).toContain('Full demo ingest: done');
    expect(summary).toContain('Saved memory: 1 wiki, 1 semantic layer');
    expect(summary).toContain('Provenance rows: 2');
    expect(summary).toContain('Next: ktx setup demo inspect');
    expect(summary).toContain('Shows the files, semantic-layer sources, and memory KTX just produced.');
    expect(summary).toContain('Next: ktx setup demo replay');
    expect(summary).toContain('Replays the same visual story without calling the LLM again.');
    expect(summary).not.toContain('--viz');
  });
});
