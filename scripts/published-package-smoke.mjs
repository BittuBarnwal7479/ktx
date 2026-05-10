#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  buildPublishedPackageSmokeCommands,
  readPublishedPackageSmokeConfigFromPolicyFile,
} from './published-package-smoke-config.mjs';

export {
  buildPublishedPackageNpxCommand,
  buildPublishedPackageSmokeCommands,
  publishedPackageSpec,
  readPublishedPackageSmokeConfig,
} from './published-package-smoke-config.mjs';

const execFileAsync = promisify(execFile);
const SMOKE_TIMEOUT_MS = 180_000;

function scriptRootDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function releasePolicyPath(rootDir = scriptRootDir()) {
  return join(rootDir, 'release-policy.json');
}

async function runCommand(command, args, options = {}) {
  process.stdout.write(`$ ${command} ${args.join(' ')}\n`);
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: Object.assign({}, process.env, options.env ?? {}),
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: SMOKE_TIMEOUT_MS,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? error.message,
    };
  }
}

function requireSuccess(label, result) {
  assert.equal(
    result.code,
    0,
    `${label} failed with code ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function parseJson(label, text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} did not produce JSON: ${error instanceof Error ? error.message : String(error)}\n${text}`);
  }
}

function assertHybridWikiSearch(result) {
  const payload = parseJson('published package wiki search', result.stdout);
  assert.ok(payload.totalFound > 0, 'published package wiki search should return results');
  assert.ok(
    payload.results.some((entry) => Array.isArray(entry.matchReasons) && entry.matchReasons.length > 0),
    'published package wiki search should expose match reasons',
  );
}

function assertHybridSlSearch(result) {
  const payload = parseJson('published package semantic-layer search', result.stdout);
  assert.ok(payload.totalSources > 0, 'published package semantic-layer search should return sources');
  assert.ok(
    payload.sources.some((entry) => Array.isArray(entry.matchReasons) && entry.matchReasons.length > 0),
    'published package semantic-layer search should expose match reasons',
  );
}

function assertMissingProjectReadiness(result, emptyProjectDir) {
  assert.equal(result.code, 1, 'missing-project semantic-layer search should exit 1');
  assert.equal(result.stdout, '', 'missing-project semantic-layer search should not write JSON errors to stdout');

  const payload = parseJson('published package missing-project semantic-layer search', result.stderr);
  assert.deepEqual(payload, {
    ok: false,
    error: {
      code: 'agent_sl_search_missing_project',
      message: `Semantic-layer search needs an initialized KTX project at ${emptyProjectDir}.`,
      nextSteps: [
        'ktx demo',
        `ktx setup --project-dir ${emptyProjectDir}`,
        'ktx ingest <connection>',
        `ktx agent sl list --json --query "revenue" --project-dir ${emptyProjectDir}`,
      ],
    },
  });
}

export async function runPublishedPackageSmoke(config) {
  const root = await mkdtemp(join(tmpdir(), 'ktx-published-package-smoke-'));
  try {
    const projectDir = join(root, 'demo-project');
    const emptyProjectDir = join(root, 'empty-project');
    await mkdir(emptyProjectDir, { recursive: true });

    const commands = buildPublishedPackageSmokeCommands(config, projectDir, emptyProjectDir);
    for (const command of commands.slice(0, 4)) {
      const result = await runCommand(command.command, command.args, { env: command.env });
      requireSuccess(command.label, result);
      if (command.label === 'published package wiki hybrid search') {
        assertHybridWikiSearch(result);
      }
      if (command.label === 'published package semantic-layer hybrid search') {
        assertHybridSlSearch(result);
      }
    }

    const missingProjectCommand = commands[4];
    const missingProject = await runCommand(missingProjectCommand.command, missingProjectCommand.args, {
      env: missingProjectCommand.env,
    });
    assertMissingProjectReadiness(missingProject, emptyProjectDir);

    process.stdout.write('published package hybrid search smoke verified\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  const config = await readPublishedPackageSmokeConfigFromPolicyFile(
    releasePolicyPath(),
    process.env,
    process.argv.slice(2),
  );

  if (!config.enabled) {
    if (config.requireConfig) {
      throw new Error(config.reason);
    }
    process.stdout.write(`Published KTX package smoke skipped: ${config.reason}\n`);
    return;
  }

  await runPublishedPackageSmoke(config);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}
