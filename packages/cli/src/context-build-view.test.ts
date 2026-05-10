import { buildDefaultKtxProjectConfig, type KtxProjectConfig } from '@ktx/context/project';
import { describe, expect, it, vi } from 'vitest';
import type { KtxPublicIngestProject, KtxPublicIngestTargetResult } from './public-ingest.js';
import {
  extractProgressMessage,
  initViewState,
  parseIngestSummary,
  parseScanSummary,
  renderContextBuildView,
  runContextBuild,
} from './context-build-view.js';

function makeIo(options: { isTTY?: boolean } = {}) {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: {
        isTTY: options.isTTY,
        write: (chunk: string) => {
          stdout += chunk;
        },
      },
      stderr: {
        write: (chunk: string) => {
          stderr += chunk;
        },
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function projectWithConnections(connections: KtxProjectConfig['connections']): KtxPublicIngestProject {
  return {
    projectDir: '/tmp/project',
    config: {
      ...buildDefaultKtxProjectConfig('warehouse'),
      connections,
    },
  };
}

function successResult(connectionId: string, driver: string, operation: 'scan' | 'source-ingest'): KtxPublicIngestTargetResult {
  return {
    connectionId,
    driver,
    steps: [
      { operation: 'scan', status: operation === 'scan' ? 'done' : 'skipped' },
      { operation: 'source-ingest', status: operation === 'source-ingest' ? 'done' : 'skipped' },
      { operation: 'enrich', status: 'skipped' },
      { operation: 'memory-update', status: operation === 'source-ingest' ? 'done' : 'skipped' },
    ],
  };
}

function failedResult(connectionId: string, driver: string, operation: 'scan' | 'source-ingest'): KtxPublicIngestTargetResult {
  return {
    connectionId,
    driver,
    steps: [
      { operation: 'scan', status: operation === 'scan' ? 'failed' : 'skipped', detail: `${connectionId} failed at scan.` },
      { operation: 'source-ingest', status: operation === 'source-ingest' ? 'failed' : 'skipped' },
      { operation: 'enrich', status: 'skipped' },
      { operation: 'memory-update', status: 'not-run' },
    ],
  };
}

describe('extractProgressMessage', () => {
  it('extracts percentage and message from scan progress', () => {
    expect(extractProgressMessage('\r[45%] Scanning tables...[K')).toBe('[45%] Scanning tables...');
  });

  it('extracts from permanent progress lines', () => {
    expect(extractProgressMessage('[100%] Done\n')).toBe('[100%] Done');
  });

  it('returns null for non-progress output', () => {
    expect(extractProgressMessage('KTX scan completed\n')).toBeNull();
  });
});

describe('parseScanSummary', () => {
  it('extracts table count from scan output', () => {
    expect(parseScanSummary('Semantic layer comparison found 5 changes across 42 tables')).toBe('42 tables');
  });

  it('handles singular form', () => {
    expect(parseScanSummary('found 1 change across 1 table')).toBe('1 tables');
  });

  it('returns null when no match', () => {
    expect(parseScanSummary('No changes detected')).toBeNull();
  });
});

describe('parseIngestSummary', () => {
  it('extracts work units and saved memory', () => {
    expect(parseIngestSummary('Work units: 5\nSaved memory: 3 wiki, 2 SL')).toBe('5 work units · 3 wiki, 2 SL');
  });

  it('extracts work units alone when no saved memory', () => {
    expect(parseIngestSummary('Work units: 5\nStatus: done')).toBe('5 work units');
  });

  it('extracts saved memory alone when no work units', () => {
    expect(parseIngestSummary('Saved memory: 3 wiki, 2 SL')).toBe('3 wiki, 2 SL');
  });

  it('returns null when no match', () => {
    expect(parseIngestSummary('Status: done')).toBeNull();
  });
});

describe('initViewState', () => {
  it('partitions targets into primary and context sources', () => {
    const state = initViewState([
      { connectionId: 'warehouse', driver: 'postgres', operation: 'scan', debugCommand: '', steps: ['scan'] },
      { connectionId: 'dbt-main', driver: 'dbt', operation: 'source-ingest', adapter: 'dbt', debugCommand: '', steps: ['source-ingest', 'memory-update'] },
    ]);

    expect(state.primarySources).toHaveLength(1);
    expect(state.primarySources[0].target.connectionId).toBe('warehouse');
    expect(state.contextSources).toHaveLength(1);
    expect(state.contextSources[0].target.connectionId).toBe('dbt-main');
    expect(state.frame).toBe(0);
  });
});

describe('renderContextBuildView', () => {
  it('renders all-queued state', () => {
    const state = initViewState([
      { connectionId: 'warehouse', driver: 'postgres', operation: 'scan', debugCommand: '', steps: ['scan'] },
      { connectionId: 'dbt-main', driver: 'dbt', operation: 'source-ingest', adapter: 'dbt', debugCommand: '', steps: ['source-ingest', 'memory-update'] },
    ]);

    const output = renderContextBuildView(state, { styled: false });
    expect(output).toContain('Building KTX context');
    expect(output).toContain('Primary sources:');
    expect(output).toContain('warehouse');
    expect(output).toContain('queued');
    expect(output).toContain('Context sources:');
    expect(output).toContain('dbt-main');
  });

  it('renders completed state with summary', () => {
    const state = initViewState([
      { connectionId: 'warehouse', driver: 'postgres', operation: 'scan', debugCommand: '', steps: ['scan'] },
    ]);
    state.primarySources[0].status = 'done';
    state.primarySources[0].elapsedMs = 72000;
    state.primarySources[0].summaryText = '42 tables';

    const output = renderContextBuildView(state, { styled: false });
    expect(output).toContain('42 tables');
    expect(output).toContain('1m12s');
  });

  it('renders failed state', () => {
    const state = initViewState([
      { connectionId: 'warehouse', driver: 'postgres', operation: 'scan', debugCommand: '', steps: ['scan'] },
    ]);
    state.primarySources[0].status = 'failed';

    const output = renderContextBuildView(state, { styled: false });
    expect(output).toContain('✗');
    expect(output).toContain('failed');
  });

  it('omits empty groups', () => {
    const state = initViewState([
      { connectionId: 'dbt-main', driver: 'dbt', operation: 'source-ingest', adapter: 'dbt', debugCommand: '', steps: ['source-ingest', 'memory-update'] },
    ]);

    const output = renderContextBuildView(state, { styled: false });
    expect(output).not.toContain('Primary sources:');
    expect(output).toContain('Context sources:');
  });
});

describe('runContextBuild', () => {
  it('executes scan targets before source-ingest targets', async () => {
    const io = makeIo();
    const project = projectWithConnections({
      dbt_main: { driver: 'dbt' },
      warehouse: { driver: 'postgres' },
    });
    const callOrder: string[] = [];
    const executeTarget = vi.fn(async (target) => {
      callOrder.push(target.connectionId);
      return successResult(target.connectionId, target.driver, target.operation);
    });

    const result = await runContextBuild(
      project,
      { projectDir: '/tmp/project', inputMode: 'disabled' },
      io.io,
      { executeTarget, now: () => 1000 },
    );

    expect(result).toEqual({ exitCode: 0, detached: false });
    expect(callOrder).toEqual(['warehouse', 'dbt_main']);
  });

  it('returns exit code 1 when any target fails', async () => {
    const io = makeIo();
    const project = projectWithConnections({
      warehouse: { driver: 'postgres' },
    });
    const executeTarget = vi.fn(async (target) => failedResult(target.connectionId, target.driver, target.operation));

    const result = await runContextBuild(
      project,
      { projectDir: '/tmp/project', inputMode: 'disabled' },
      io.io,
      { executeTarget, now: () => 1000 },
    );

    expect(result).toEqual({ exitCode: 1, detached: false });
  });

  it('renders final view for non-TTY output', async () => {
    const io = makeIo();
    const project = projectWithConnections({
      warehouse: { driver: 'postgres' },
      dbt_main: { driver: 'dbt' },
    });
    const executeTarget = vi.fn(async (target) => successResult(target.connectionId, target.driver, target.operation));

    await runContextBuild(
      project,
      { projectDir: '/tmp/project', inputMode: 'disabled' },
      io.io,
      { executeTarget, now: () => 1000 },
    );

    const output = io.stdout();
    expect(output).toContain('Building KTX context');
    expect(output).toContain('Primary sources:');
    expect(output).toContain('warehouse');
    expect(output).toContain('Context sources:');
    expect(output).toContain('dbt_main');
  });

  it('passes scan mode and detect relationships through to target execution', async () => {
    const io = makeIo();
    const project = projectWithConnections({ warehouse: { driver: 'postgres' } });
    const executeTarget = vi.fn(async (target) => successResult(target.connectionId, target.driver, target.operation));

    await runContextBuild(
      project,
      { projectDir: '/tmp/project', inputMode: 'disabled', scanMode: 'enriched', detectRelationships: true },
      io.io,
      { executeTarget, now: () => 1000 },
    );

    expect(executeTarget).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'warehouse', operation: 'scan' }),
      expect.objectContaining({ scanMode: 'enriched', detectRelationships: true }),
      expect.anything(),
      {},
    );
  });

  it('exits immediately with paused message when d is pressed', async () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    const io = makeIo();
    const project = projectWithConnections({
      warehouse: { driver: 'postgres' },
      dbt_main: { driver: 'dbt' },
    });
    let triggerDetach: (() => void) | null = null;
    const executeTarget = vi.fn(async (target) => {
      if (target.connectionId === 'warehouse') triggerDetach?.();
      return successResult(target.connectionId, target.driver, target.operation);
    });

    await expect(
      runContextBuild(
        project,
        { projectDir: '/tmp/project', inputMode: 'disabled' },
        io.io,
        {
          executeTarget,
          now: () => 1000,
          setupKeystroke: (onDetach) => {
            triggerDetach = onDetach;
            return () => {};
          },
        },
      ),
    ).rejects.toThrow('process.exit');

    expect(mockExit).toHaveBeenCalledWith(0);
    expect(io.stdout()).toContain('Context build continuing in the background.');
    expect(io.stdout()).toContain('Resume: ktx setup --project-dir /tmp/project');
    mockExit.mockRestore();
  });
});
