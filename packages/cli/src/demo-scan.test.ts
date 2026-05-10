import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findLatestDemoScanReport, runDemoScan } from './demo-scan.js';

describe('demo scan helpers', () => {
  const projectDir = join(tmpdir(), `ktx-demo-scan-${process.pid}`);

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('runs the packaged SQLite demo scan and finds the latest scan report', async () => {
    const { result } = await runDemoScan({
      projectDir,
      jobId: 'demo-scan-test',
      now: () => new Date('2026-05-06T10:00:00.000Z'),
    });

    expect(result.report).toMatchObject({
      connectionId: 'orbit_demo',
      driver: 'sqlite',
      runId: 'demo-scan-test',
      mode: 'structural',
      dryRun: false,
    });
    expect(result.report.artifactPaths.reportPath).toContain('raw-sources/orbit_demo/live-database/');
    await expect(findLatestDemoScanReport(projectDir)).resolves.toMatchObject({ runId: 'demo-scan-test' });
  });
});
