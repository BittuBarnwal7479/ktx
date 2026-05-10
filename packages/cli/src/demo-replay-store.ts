import { constants as fsConstants } from 'node:fs';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseMemoryFlowReplayInput, type MemoryFlowReplayInput } from '@ktx/context/ingest/memory-flow';

interface StoredMemoryFlowReplayFile {
  memoryFlowReplaySchemaVersion: 1;
  replay: unknown;
}

interface SavedDemoReplay {
  replayPath: string;
  latestReplayPath: string;
}

export const DEMO_LATEST_REPLAY_FILE = 'latest.memory-flow.v1.json';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function safeReplayName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'replay';
}

function demoReplayFileName(input: MemoryFlowReplayInput, label: string): string {
  return `${safeReplayName(label)}-${safeReplayName(input.runId)}.memory-flow.v1.json`;
}

function wrapReplay(input: MemoryFlowReplayInput): StoredMemoryFlowReplayFile {
  return { memoryFlowReplaySchemaVersion: 1, replay: input };
}

export async function loadDemoReplayFile(path: string): Promise<MemoryFlowReplayInput> {
  const parsed = JSON.parse(await readFile(path, 'utf-8')) as StoredMemoryFlowReplayFile;
  if (parsed.memoryFlowReplaySchemaVersion !== 1) {
    throw new Error(`Unsupported demo replay schema version in ${path}`);
  }
  return parseMemoryFlowReplayInput(parsed.replay);
}

export async function loadLatestDemoReplay(projectDir: string): Promise<MemoryFlowReplayInput | null> {
  const latestPath = join(resolve(projectDir), 'replays', DEMO_LATEST_REPLAY_FILE);
  if (!(await exists(latestPath))) {
    return null;
  }
  return loadDemoReplayFile(latestPath);
}

export async function writeDemoReplay(
  projectDir: string,
  input: MemoryFlowReplayInput,
  options: { label: 'full' | 'deterministic' | 'seeded' },
): Promise<SavedDemoReplay> {
  const replayDir = join(resolve(projectDir), 'replays');
  await mkdir(replayDir, { recursive: true });
  const replayPath = join(replayDir, demoReplayFileName(input, options.label));
  const latestReplayPath = join(replayDir, DEMO_LATEST_REPLAY_FILE);
  const body = `${JSON.stringify(wrapReplay(input), null, 2)}\n`;
  await writeFile(replayPath, body, 'utf-8');
  await copyFile(replayPath, latestReplayPath);
  return { replayPath, latestReplayPath };
}
