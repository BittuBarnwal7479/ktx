import type { MemoryFlowEvent, MemoryFlowReplayInput } from '@ktx/context/ingest/memory-flow';
import type { KtxDemoIo } from './demo.js';

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function formatDiff(added: number, modified: number, deleted: number, unchanged: number): string {
  const parts: string[] = [];
  if (added > 0) parts.push(`+${added} new`);
  if (modified > 0) parts.push(`~${modified} changed`);
  if (deleted > 0) parts.push(`-${deleted} removed`);
  if (unchanged > 0) parts.push(`=${unchanged} unchanged`);
  return parts.length > 0 ? parts.join(', ') : 'no changes';
}

export function formatMemoryFlowEventLine(event: MemoryFlowEvent): string | null {
  switch (event.type) {
    case 'source_acquired':
      return `[connect]  Connected ${event.adapter} - ${plural(event.fileCount, 'database file')} (${event.trigger})`;
    case 'scope_detected':
      return event.fingerprint
        ? `[scope]    Scope locked: ${event.fingerprint}`
        : '[scope]    Reviewing the whole warehouse (no scope filter)';
    case 'raw_snapshot_written':
      return `[snapshot] Captured snapshot ${event.syncId} - ${plural(event.rawFileCount, 'file')}`;
    case 'diff_computed':
      return `[diff]     Tables: ${formatDiff(event.added, event.modified, event.deleted, event.unchanged)}`;
    case 'chunks_planned':
      return event.evictionCount > 0
        ? `[plan]     Grouped ${plural(event.workUnitCount, 'table')} into ${plural(event.chunkCount, 'business area')} (${plural(event.evictionCount, 'removal')})`
        : `[plan]     Grouped ${plural(event.workUnitCount, 'table')} into ${plural(event.chunkCount, 'business area')}`;
    case 'stage_skipped':
      return `[skip]     ${event.stage} skipped: ${event.reason}`;
    case 'work_unit_started':
      return `[analyze]  Reviewing "${event.unitKey}" - budget ${plural(event.stepBudget, 'agent step')}`;
    case 'work_unit_step':
      return null;
    case 'candidate_action': {
      const target = event.target === 'sl' ? 'semantic-layer' : 'wiki';
      return `[draft]    ${event.unitKey} -> ${target}: ${event.action} ${event.key}`;
    }
    case 'work_unit_finished':
      if (event.status === 'success') {
        return `[done]     ${event.unitKey} reviewed`;
      }
      return `[fail]     ${event.unitKey} needs attention${event.reason ? ` - ${event.reason}` : ''}`;
    case 'reconciliation_finished': {
      const conflicts = event.conflictCount === 0 ? 'no conflicts' : plural(event.conflictCount, 'conflict');
      const fallbacks = event.fallbackCount === 0 ? 'nothing flagged for review' : `${plural(event.fallbackCount, 'item')} flagged for review`;
      return `[validate] Reconciled drafts - ${conflicts}, ${fallbacks}`;
    }
    case 'saved': {
      const total = event.wikiCount + event.slCount;
      const commit = event.commitSha ? ` - commit ${event.commitSha.slice(0, 7)}` : '';
      return `[memory]   Saved ${plural(total, 'memory', 'memories')} (${event.wikiCount} wiki, ${event.slCount} semantic-layer)${commit}`;
    }
    case 'provenance_recorded':
      return `[trace]    Recorded provenance for ${plural(event.rowCount, 'row')}`;
    case 'report_created':
      return `[report]   Run report ready: ${event.runId}`;
  }
}

export function createPlainProgressEmitter(io: KtxDemoIo): (snapshot: MemoryFlowReplayInput) => void {
  let printed = 0;
  return (snapshot) => {
    while (printed < snapshot.events.length) {
      const event = snapshot.events[printed++];
      if (!event) continue;
      const line = formatMemoryFlowEventLine(event);
      if (line !== null) {
        io.stdout.write(`${line}\n`);
      }
    }
  };
}
