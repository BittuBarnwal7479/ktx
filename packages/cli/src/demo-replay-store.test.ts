import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type MemoryFlowReplayInput } from '@ktx/context/ingest/memory-flow';
import { describe, expect, it } from 'vitest';
import { DEMO_LATEST_REPLAY_FILE, loadLatestDemoReplay, writeDemoReplay } from './demo-replay-store.js';

function replay(overrides: Partial<MemoryFlowReplayInput> = {}): MemoryFlowReplayInput {
  return {
    metadata: {
      schemaVersion: 1,
      mode: 'full',
      origin: 'captured',
      timing: 'captured',
      capturedAt: '2026-05-01T10:00:03.000Z',
      sourceReportId: 'report-1',
      sourceReportPath: 'report-1',
      fallbackReason: null,
    },
    runId: 'run-1',
    connectionId: 'orbit_demo',
    adapter: 'live-database',
    status: 'done',
    sourceDir: null,
    syncId: 'sync-1',
    reportId: 'report-1',
    reportPath: 'report-1',
    errors: [],
    events: [{ type: 'report_created', runId: 'run-1', reportPath: 'report-1', emittedAt: '2026-05-01T10:00:03.000Z' }],
    plannedWorkUnits: [],
    details: { actions: [], provenance: [], transcripts: [] },
    ...overrides,
  };
}

describe('demo replay store', () => {
  it('writes a versioned replay file and updates latest', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'ktx-demo-replay-store-'));

    const saved = await writeDemoReplay(projectDir, replay(), { label: 'full' });

    expect(saved.replayPath).toMatch(/replays[/\\]full-run-1.memory-flow.v1.json$/);
    expect(saved.latestReplayPath).toBe(join(projectDir, 'replays', DEMO_LATEST_REPLAY_FILE));
    expect(await loadLatestDemoReplay(projectDir)).toMatchObject({
      runId: 'run-1',
      metadata: { mode: 'full', origin: 'captured', timing: 'captured' },
    });

    const wrapper = JSON.parse(await readFile(saved.latestReplayPath, 'utf-8')) as {
      memoryFlowReplaySchemaVersion?: number;
    };
    expect(wrapper.memoryFlowReplaySchemaVersion).toBe(1);
  });

  it('returns null when no latest local replay exists', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'ktx-demo-replay-store-empty-'));

    await expect(loadLatestDemoReplay(projectDir)).resolves.toBeNull();
  });
});
