import { describe, expect, it } from 'vitest';

describe('@ktx/context/ingest/memory-flow lightweight export', () => {
  it('exports replay parsing and text rendering without the full ingest entry point', async () => {
    const memoryFlow = await import('./index.js');

    expect(memoryFlow.parseMemoryFlowReplayInput).toBeTypeOf('function');
    expect(memoryFlow.buildMemoryFlowViewModel).toBeTypeOf('function');
    expect(memoryFlow.renderMemoryFlowReplay).toBeTypeOf('function');
  });
});
