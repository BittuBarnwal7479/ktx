import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureDemoProject } from './demo-assets.js';
import {
  chooseDemoProjectForInteractiveRun,
  createTestDemoPromptAdapter,
  resolveFullCredentialDecision,
} from './demo-interaction.js';

function io(isTTY: boolean) {
  return {
    stdin: { isTTY },
    stdout: { isTTY, write: vi.fn() },
    stderr: { write: vi.fn() },
  };
}

describe('demo interaction decisions', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-demo-interaction-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('reuses a valid project without prompting in no-input mode', async () => {
    await ensureDemoProject({ projectDir: tempDir, force: false });

    await expect(
      chooseDemoProjectForInteractiveRun({
        projectDir: tempDir,
        inputMode: 'disabled',
        io: io(false),
        prompts: createTestDemoPromptAdapter({ choices: [] }),
      }),
    ).resolves.toEqual({ action: 'use', projectDir: tempDir, reset: false });
  });

  it('fails corrupted projects in no-input mode with reset guidance', async () => {
    await ensureDemoProject({ projectDir: tempDir, force: false });
    await rm(join(tempDir, 'demo.db'), { force: true });

    await expect(
      chooseDemoProjectForInteractiveRun({
        projectDir: tempDir,
        inputMode: 'disabled',
        io: io(false),
        prompts: createTestDemoPromptAdapter({ choices: [] }),
      }),
    ).rejects.toThrow(
      `Demo project is not ready at ${tempDir}: missing demo.db. Run ktx setup demo reset --project-dir ${tempDir} --force --no-input`,
    );
  });

  it('lets interactive users reset a corrupted project', async () => {
    await ensureDemoProject({ projectDir: tempDir, force: false });
    await rm(join(tempDir, 'demo.db'), { force: true });

    await expect(
      chooseDemoProjectForInteractiveRun({
        projectDir: tempDir,
        io: io(true),
        prompts: createTestDemoPromptAdapter({ choices: ['reset'], confirms: [true] }),
      }),
    ).resolves.toEqual({ action: 'use', projectDir: tempDir, reset: true });
  });

  it('lets interactive users choose another project directory', async () => {
    await ensureDemoProject({ projectDir: tempDir, force: false });
    const otherDir = join(tempDir, 'other-demo');

    await expect(
      chooseDemoProjectForInteractiveRun({
        projectDir: tempDir,
        io: io(true),
        prompts: createTestDemoPromptAdapter({ choices: ['other'], texts: [otherDir] }),
      }),
    ).resolves.toEqual({ action: 'use', projectDir: otherDir, reset: false });
  });

  it('uses a pasted Anthropic key only for the returned process env', async () => {
    // pragma: allowlist secret
    const prompts = createTestDemoPromptAdapter({ choices: ['process_key'], passwords: ['sk-ant-process'] });

    await expect(
      resolveFullCredentialDecision({
        needsAnthropicKey: true,
        inputMode: 'auto',
        io: io(true),
        env: {},
        prompts,
      }),
    ).resolves.toEqual({
      action: 'full',
      env: { ANTHROPIC_API_KEY: 'sk-ant-process' }, // pragma: allowlist secret
    });
  });

  it('lets interactive users explicitly choose seeded mode when the key is missing', async () => {
    await expect(
      resolveFullCredentialDecision({
        needsAnthropicKey: true,
        inputMode: 'auto',
        io: io(true),
        env: {},
        prompts: createTestDemoPromptAdapter({ choices: ['seeded'] }),
      }),
    ).resolves.toEqual({ action: 'run-mode', mode: 'seeded' });
  });

  it('does not prompt when input is disabled', async () => {
    await expect(
      resolveFullCredentialDecision({
        needsAnthropicKey: true,
        inputMode: 'disabled',
        io: io(false),
        env: {},
        prompts: createTestDemoPromptAdapter({ choices: ['seeded'] }),
      }),
    ).resolves.toEqual({ action: 'full', env: {} });
  });
});
