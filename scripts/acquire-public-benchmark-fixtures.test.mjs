import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { acquirePublicBenchmarkFixtures } from './acquire-public-benchmark-fixtures.mjs';

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), 'ktx-acquire-'));
}

function writeManifest(dir, fixtures) {
  const p = path.join(dir, 'manifest.json');
  writeFileSync(p, JSON.stringify({ fixtures }), 'utf8');
  return p;
}

describe('acquirePublicBenchmarkFixtures', () => {
  it('downloads, hashes, and writes data.sqlite for each manifest entry', async () => {
    const root = tempRoot();
    try {
      const fixturesRoot = path.join(root, 'fixtures');
      const manifestPath = writeManifest(root, [
        { id: 'foo_fixture', url: 'https://example.invalid/foo', sha256: '' },
      ]);
      const calls = [];
      const result = await acquirePublicBenchmarkFixtures({
        manifestPath,
        fixturesRoot,
        fetch: async (url) => {
          calls.push(url);
          return {
            ok: true,
            status: 200,
            async arrayBuffer() {
              return Buffer.from('hello-sqlite');
            },
          };
        },
        log: () => {},
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0], 'https://example.invalid/foo');
      assert.equal(result.length, 1);
      assert.equal(result[0].action, 'downloaded');
      const dest = path.join(fixturesRoot, 'foo_fixture', 'data.sqlite');
      assert.ok(existsSync(dest));
      assert.equal(readFileSync(dest, 'utf8'), 'hello-sqlite');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips when existing file matches the manifest sha256', async () => {
    const root = tempRoot();
    try {
      const fixturesRoot = path.join(root, 'fixtures');
      const fixtureDir = path.join(fixturesRoot, 'foo_fixture');
      const dest = path.join(fixtureDir, 'data.sqlite');
      const { mkdirSync } = await import('node:fs');
      mkdirSync(fixtureDir, { recursive: true });
      writeFileSync(dest, Buffer.from('hello-sqlite'));
      const expectedHash = '52a3e2d435cdf97a44eca3dd4882d008b9ef73b63bc75476d320fdd665c812c0'; // pragma: allowlist secret
      const manifestPath = writeManifest(root, [
        { id: 'foo_fixture', url: 'https://example.invalid/foo', sha256: expectedHash },
      ]);
      let fetchCalls = 0;
      const result = await acquirePublicBenchmarkFixtures({
        manifestPath,
        fixturesRoot,
        fetch: async () => {
          fetchCalls += 1;
          throw new Error('should not fetch');
        },
        log: () => {},
      });
      assert.equal(result[0].action, 'skip');
      assert.equal(fetchCalls, 0);
      assert.equal(readFileSync(dest, 'utf8'), 'hello-sqlite');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('throws when the downloaded payload sha256 does not match the manifest', async () => {
    const root = tempRoot();
    try {
      const fixturesRoot = path.join(root, 'fixtures');
      const manifestPath = writeManifest(root, [
        {
          id: 'foo_fixture',
          url: 'https://example.invalid/foo',
          sha256: '0000000000000000000000000000000000000000000000000000000000000000',
        },
      ]);
      await assert.rejects(
        acquirePublicBenchmarkFixtures({
          manifestPath,
          fixturesRoot,
          fetch: async () => ({
            ok: true,
            status: 200,
            async arrayBuffer() {
              return Buffer.from('different-payload');
            },
          }),
          log: () => {},
        }),
        /Hash mismatch/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('surfaces non-OK HTTP statuses with the fixture id', async () => {
    const root = tempRoot();
    try {
      const fixturesRoot = path.join(root, 'fixtures');
      const manifestPath = writeManifest(root, [
        { id: 'foo_fixture', url: 'https://example.invalid/foo', sha256: '' },
      ]);
      await assert.rejects(
        acquirePublicBenchmarkFixtures({
          manifestPath,
          fixturesRoot,
          fetch: async () => ({
            ok: false,
            status: 404,
            async arrayBuffer() {
              return Buffer.alloc(0);
            },
          }),
          log: () => {},
        }),
        /foo_fixture .* HTTP 404/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('pins every checked-in public benchmark fixture download in the manifest', () => {
    const manifestPath = new URL('./public-benchmark-manifest.json', import.meta.url);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const fixtureIds = manifest.fixtures.map((fixture) => fixture.id).sort();

    assert.deepEqual(fixtureIds, [
      'adventureworkslt_with_declared_metadata',
      'chinook_with_declared_metadata',
      'northwind_with_declared_metadata',
      'sakila_with_declared_metadata',
    ]);

    const adventureWorks = manifest.fixtures.find(
      (fixture) => fixture.id === 'adventureworkslt_with_declared_metadata',
    );
    assert.ok(adventureWorks);
    assert.equal(adventureWorks.displayName, 'AdventureWorksLT (SQLite, declared metadata)');
    assert.equal(
      adventureWorks.url,
      'https://github.com/nuitsjp/AdventureWorks-for-SQLite/releases/download/Release-1_0_0/AdventureWorksLT.db',
    );
    assert.equal(adventureWorks.sha256, 'f1a87a31f4efb5654f57a3b1ca47fac338972ceb7553673d66ea0bd9d55a7008'); // pragma: allowlist secret
    assert.equal(adventureWorks.license, 'MIT');
    assert.equal(adventureWorks.source, 'https://github.com/nuitsjp/AdventureWorks-for-SQLite');
  });
});
