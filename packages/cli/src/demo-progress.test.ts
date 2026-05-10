import type { MemoryFlowEvent, MemoryFlowReplayInput } from '@ktx/context/ingest/memory-flow';
import { describe, expect, it } from 'vitest';
import { createPlainProgressEmitter, formatMemoryFlowEventLine } from './demo-progress.js';

function snapshot(events: MemoryFlowEvent[]): MemoryFlowReplayInput {
  return {
    runId: 'run-1',
    connectionId: 'orbit_demo',
    adapter: 'live-database',
    status: 'running',
    sourceDir: null,
    syncId: 'sync-1',
    errors: [],
    events,
    plannedWorkUnits: [],
    details: { actions: [], provenance: [], transcripts: [] },
  };
}

describe('formatMemoryFlowEventLine', () => {
  it('formats source_acquired in plain English with adapter and file count', () => {
    expect(
      formatMemoryFlowEventLine({
        type: 'source_acquired',
        adapter: 'live-database',
        trigger: 'manual_resync',
        fileCount: 7,
      }),
    ).toBe('[connect]  Connected live-database - 7 database files (manual_resync)');
  });

  it('formats diff_computed as a comma-separated breakdown', () => {
    expect(
      formatMemoryFlowEventLine({
        type: 'diff_computed',
        added: 3,
        modified: 1,
        deleted: 0,
        unchanged: 4,
      }),
    ).toBe('[diff]     Tables: +3 new, ~1 changed, =4 unchanged');
  });

  it('formats diff_computed as "no changes" when every counter is zero', () => {
    expect(
      formatMemoryFlowEventLine({
        type: 'diff_computed',
        added: 0,
        modified: 0,
        deleted: 0,
        unchanged: 0,
      }),
    ).toBe('[diff]     Tables: no changes');
  });

  it('formats chunks_planned without removals as a single readable sentence', () => {
    expect(
      formatMemoryFlowEventLine({
        type: 'chunks_planned',
        chunkCount: 7,
        workUnitCount: 5,
        evictionCount: 0,
      }),
    ).toBe('[plan]     Grouped 5 tables into 7 business areas');
  });

  it('formats chunks_planned with removals when evictions are non-zero', () => {
    expect(
      formatMemoryFlowEventLine({
        type: 'chunks_planned',
        chunkCount: 7,
        workUnitCount: 5,
        evictionCount: 2,
      }),
    ).toBe('[plan]     Grouped 5 tables into 7 business areas (2 removals)');
  });

  it('formats work_unit_started in human terms', () => {
    expect(
      formatMemoryFlowEventLine({
        type: 'work_unit_started',
        unitKey: 'revenue-policy',
        skills: ['sl_expert', 'wiki_writer'],
        stepBudget: 40,
      }),
    ).toBe('[analyze]  Reviewing "revenue-policy" - budget 40 agent steps');
  });

  it('suppresses noisy work_unit_step events', () => {
    expect(
      formatMemoryFlowEventLine({
        type: 'work_unit_step',
        unitKey: 'revenue-policy',
        stepIndex: 3,
        stepBudget: 40,
      }),
    ).toBeNull();
  });

  it('formats candidate_action with friendly target and arrow', () => {
    expect(
      formatMemoryFlowEventLine({
        type: 'candidate_action',
        unitKey: 'revenue-policy',
        target: 'sl',
        action: 'created',
        key: 'warehouse.revenue',
      }),
    ).toBe('[draft]    revenue-policy -> semantic-layer: created warehouse.revenue');
  });

  it('formats work_unit_finished with status-aware tag', () => {
    expect(
      formatMemoryFlowEventLine({
        type: 'work_unit_finished',
        unitKey: 'revenue-policy',
        status: 'success',
      }),
    ).toBe('[done]     revenue-policy reviewed');

    expect(
      formatMemoryFlowEventLine({
        type: 'work_unit_finished',
        unitKey: 'revenue-policy',
        status: 'failed',
        reason: 'budget exhausted',
      }),
    ).toBe('[fail]     revenue-policy needs attention - budget exhausted');
  });

  it('formats reconciliation_finished with friendly counter wording', () => {
    expect(
      formatMemoryFlowEventLine({
        type: 'reconciliation_finished',
        conflictCount: 0,
        fallbackCount: 0,
      }),
    ).toBe('[validate] Reconciled drafts - no conflicts, nothing flagged for review');

    expect(
      formatMemoryFlowEventLine({
        type: 'reconciliation_finished',
        conflictCount: 2,
        fallbackCount: 1,
      }),
    ).toBe('[validate] Reconciled drafts - 2 conflicts, 1 item flagged for review');
  });

  it('formats saved with optional shortened commit sha and pluralized memory count', () => {
    expect(
      formatMemoryFlowEventLine({
        type: 'saved',
        commitSha: 'abc1234567890', // pragma: allowlist secret
        wikiCount: 2,
        slCount: 5,
      }),
    ).toBe('[memory]   Saved 7 memories (2 wiki, 5 semantic-layer) - commit abc1234');

    expect(
      formatMemoryFlowEventLine({
        type: 'saved',
        commitSha: null,
        wikiCount: 0,
        slCount: 1,
      }),
    ).toBe('[memory]   Saved 1 memory (0 wiki, 1 semantic-layer)');
  });

  it('formats report_created with run id', () => {
    expect(
      formatMemoryFlowEventLine({
        type: 'report_created',
        runId: 'run-xyz',
      }),
    ).toBe('[report]   Run report ready: run-xyz');
  });
});

describe('createPlainProgressEmitter', () => {
  it('writes one line per new event and never re-emits prior events', () => {
    const written: string[] = [];
    const io = {
      stdout: { write: (chunk: string) => written.push(chunk), isTTY: false },
      stderr: { write: () => undefined },
    };
    const emit = createPlainProgressEmitter(io);

    emit(
      snapshot([
        { type: 'source_acquired', adapter: 'live-database', trigger: 'manual_resync', fileCount: 7 },
        { type: 'diff_computed', added: 0, modified: 0, deleted: 0, unchanged: 7 },
      ]),
    );

    emit(
      snapshot([
        { type: 'source_acquired', adapter: 'live-database', trigger: 'manual_resync', fileCount: 7 },
        { type: 'diff_computed', added: 0, modified: 0, deleted: 0, unchanged: 7 },
        { type: 'work_unit_started', unitKey: 'revenue-policy', skills: ['sl_expert'], stepBudget: 40 },
      ]),
    );

    expect(written).toEqual([
      '[connect]  Connected live-database - 7 database files (manual_resync)\n',
      '[diff]     Tables: =7 unchanged\n',
      '[analyze]  Reviewing "revenue-policy" - budget 40 agent steps\n',
    ]);
  });

  it('skips suppressed events without advancing visible output', () => {
    const written: string[] = [];
    const io = {
      stdout: { write: (chunk: string) => written.push(chunk), isTTY: false },
      stderr: { write: () => undefined },
    };
    const emit = createPlainProgressEmitter(io);

    emit(
      snapshot([
        { type: 'work_unit_step', unitKey: 'a', stepIndex: 1, stepBudget: 40 },
        { type: 'work_unit_step', unitKey: 'a', stepIndex: 2, stepBudget: 40 },
        { type: 'work_unit_finished', unitKey: 'a', status: 'success' },
      ]),
    );

    expect(written).toEqual(['[done]     a reviewed\n']);
  });
});
