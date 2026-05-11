import { mkdir, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SqlAnalysisPort } from '../../../sql-analysis/index.js';
import { stagePgStatStatementsTemplates, writePgssBaselineAtomic, type PgssBaseline } from './stage-pgss.js';
import type { HistoricSqlPullConfig, KtxPostgresQueryClient, PostgresPgssReader, PostgresPgssRow } from './types.js';

const FIXTURE_ROOT = join(__dirname, '__fixtures__/postgres');

interface GoldenFixture {
  name: string;
  now: string;
  connectionId: string;
  probe: {
    pgServerVersion: string;
    warnings: string[];
  };
  snapshot: {
    statsResetAt: string | null;
    deallocCount: number | null;
    rows: PostgresPgssRow[];
  };
  pullConfig: HistoricSqlPullConfig & { dialect: 'postgres' };
  analysisBySql: Record<
    string,
    {
      fingerprint: string;
      normalizedSql: string;
      tablesTouched: string[];
      literalSlots: [];
      error?: string;
    }
  >;
  baseline: PgssBaseline | null;
  expectedBaseline: PgssBaseline;
  expectedFiles: Record<string, { json?: unknown; text?: string }>;
}

async function readFixture(name: string): Promise<GoldenFixture> {
  return JSON.parse(await readFile(join(FIXTURE_ROOT, name, 'input.json'), 'utf-8')) as GoldenFixture;
}

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function fakePgClient(): KtxPostgresQueryClient {
  return {
    async executeQuery() {
      return { headers: [], rows: [] };
    },
  };
}

function fixtureReader(fixture: GoldenFixture): PostgresPgssReader {
  return {
    async probe() {
      return fixture.probe;
    },
    async readSnapshot(_client, options) {
      return {
        statsResetAt: fixture.snapshot.statsResetAt,
        deallocCount: fixture.snapshot.deallocCount,
        rows: fixture.snapshot.rows.slice(0, options.maxTemplates),
      };
    },
  };
}

function fixtureSqlAnalysis(fixture: GoldenFixture): SqlAnalysisPort {
  return {
    async analyzeForFingerprint(sql) {
      const result = fixture.analysisBySql[sql];
      if (!result) {
        return {
          fingerprint: '',
          normalizedSql: '',
          tablesTouched: [],
          literalSlots: [],
          error: `missing fixture analysis for ${sql}`,
        };
      }
      return result;
    },
    async analyzeBatch() {
      return new Map();
    },
  };
}

async function writeFixtureBaseline(path: string, baseline: PgssBaseline | null): Promise<void> {
  if (!baseline) {
    return;
  }
  await writePgssBaselineAtomic(path, baseline);
}

async function listFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, fullPath)));
    } else {
      files.push(relative(root, fullPath));
    }
  }
  return files;
}

async function expectGoldenFiles(stagedDir: string, expectedFiles: GoldenFixture['expectedFiles']): Promise<void> {
  const actualFiles = await listFiles(stagedDir);
  const expectedPaths = Object.keys(expectedFiles).sort();
  expect(actualFiles.sort()).toEqual(expectedPaths);

  for (const path of expectedPaths) {
    const expected = expectedFiles[path];
    const actual = await readFile(join(stagedDir, path), 'utf-8');
    if ('json' in expected) {
      expect(JSON.parse(actual)).toEqual(expected.json);
    } else {
      expect(actual).toBe(expected.text);
    }
  }
}

describe('stagePgStatStatementsTemplates golden fixtures', () => {
  it.each(['first-run', 'normal-delta', 'reset-detected', 'version-change', 'eviction-churn'] as const)(
    'matches the committed %s golden output',
    async (fixtureName) => {
      const fixture = await readFixture(fixtureName);
      const root = await tempDir(`pgss-golden-${fixtureName}-`);
      const stagedDir = join(root, 'staged');
      const baselinePath = join(root, 'cache', fixture.connectionId, 'pgss-baseline.json');
      await mkdir(dirname(baselinePath), { recursive: true });
      await writeFixtureBaseline(baselinePath, fixture.baseline);

      const result = await stagePgStatStatementsTemplates({
        stagedDir,
        connectionId: fixture.connectionId,
        queryClient: fakePgClient(),
        reader: fixtureReader(fixture),
        sqlAnalysis: fixtureSqlAnalysis(fixture),
        pullConfig: fixture.pullConfig,
        baselinePath,
        now: new Date(fixture.now),
      });

      await expectGoldenFiles(stagedDir, fixture.expectedFiles);
      expect(result.baseline).toEqual(fixture.expectedBaseline);
    },
  );
});
