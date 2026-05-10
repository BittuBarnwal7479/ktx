import type { MemoryFlowReplayInput } from '@ktx/context/ingest/memory-flow';
import {
  ensureSeededDemoProject,
  loadPackagedDemoReplay,
} from './demo-assets.js';
import { writeDemoReplay } from './demo-replay-store.js';
import { inspectSeededProject, type SeededInspectSummary } from './demo-seeded-inspect.js';

export {
  formatSeededInspect,
  inspectSeededProject,
  type DemoSeededManifest,
  type SeededInspectSummary,
} from './demo-seeded-inspect.js';

export interface DemoSeededResult {
  projectDir: string;
  replay: MemoryFlowReplayInput;
  inspect: SeededInspectSummary;
}

export async function runDemoSeeded(options: {
  projectDir: string;
}): Promise<DemoSeededResult> {
  const result = await ensureSeededDemoProject({ projectDir: options.projectDir, force: false });

  const replay = await loadPackagedDemoReplay();
  const replayWithDir: MemoryFlowReplayInput = {
    ...replay,
    sourceDir: result.projectDir,
  };

  await writeDemoReplay(result.projectDir, replayWithDir, { label: 'seeded' });
  const inspect = await inspectSeededProject(result.projectDir);

  return {
    projectDir: result.projectDir,
    replay: replayWithDir,
    inspect,
  };
}
