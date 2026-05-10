import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ciWorkflowPath = resolve(repoRoot, '.github', 'workflows', 'ci.yml');

async function readCiWorkflowOrSkip(testContext) {
  try {
    await access(ciWorkflowPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      testContext.skip('root CI workflow is absent from sparse ktx checkout');
      return null;
    }
    throw error;
  }
  return readFile(ciWorkflowPath, 'utf-8');
}

describe('KTX CI artifact upload contract', () => {
  it('uploads verified KTX package artifacts from check-ktx-subtree', async (testContext) => {
    const workflow = await readCiWorkflowOrSkip(testContext);
    if (workflow === null) {
      return;
    }

    assert.match(
      workflow,
      /name: Build ktx package artifacts and verify public smoke\s+run: cd ktx && pnpm run artifacts:build && pnpm run artifacts:verify-manifest && pnpm run artifacts:verify-demo\s+- name: Upload ktx package artifacts/s,
    );
    assert.match(workflow, /uses: actions\/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f/);
    assert.match(workflow, /name: ktx-package-artifacts-\$\{\{ github\.sha \}\}/);
    assert.match(workflow, /ktx\/dist\/artifacts\/manifest\.json/);
    assert.match(workflow, /ktx\/dist\/artifacts\/npm\/\*\.tgz/);
    assert.match(workflow, /ktx\/dist\/artifacts\/python\/\*\.whl/);
    assert.match(workflow, /ktx\/dist\/artifacts\/python\/\*\.tar\.gz/);
    assert.match(workflow, /if-no-files-found: error/);
    assert.match(workflow, /retention-days: 7/);
  });

  it('runs packed demo artifact smoke on Linux and macOS', async (testContext) => {
    const workflow = await readCiWorkflowOrSkip(testContext);
    if (workflow === null) {
      return;
    }

    assert.match(workflow, /check-ktx-packed-demo:/);
    assert.match(workflow, /matrix:\s+os: \[ubuntu-latest, macos-latest\]/s);
    assert.match(workflow, /name: Download ktx package artifacts/);
    assert.match(workflow, /path: ktx\/dist\/artifacts/);
    assert.match(workflow, /run: cd ktx && pnpm run artifacts:verify-demo/);
  });

  it('includes packed demo artifact smoke in ci-success', async (testContext) => {
    const workflow = await readCiWorkflowOrSkip(testContext);
    if (workflow === null) {
      return;
    }

    assert.match(
      workflow,
      /needs: \[check-ktx-subtree, check-ktx-packed-demo, build-python-service, test-server, build-frontend, run-pre-commit, build-docker-images\]/,
    );
    assert.match(workflow, /needs\.check-ktx-packed-demo\.result.*== "failure"/);
    assert.match(workflow, /needs\.check-ktx-packed-demo\.result.*== "cancelled"/);
  });
});
