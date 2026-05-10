import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const scriptPath = new URL('./validate-llm-debug-jsonl.mjs', import.meta.url).pathname;

function runValidator(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
  });
}

function writeDebugJsonl(records) {
  const dir = mkdtempSync(join(tmpdir(), 'ktx-llm-debug-validator-'));
  const filePath = join(dir, 'debug.jsonl');
  writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  return filePath;
}

const validRecord = {
  operationName: 'ingest-bundle-wu',
  modelRole: 'candidateExtraction',
  modelId: 'claude-sonnet-4-6',
  messageCount: 2,
  toolNames: ['emit_candidate'],
  providerOptions: [
    {
      target: 'message',
      index: 0,
      role: 'system',
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } } },
    },
    {
      target: 'message-part',
      index: 1,
      role: 'user',
      partIndex: 0,
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral', ttl: '5m' } } },
    },
    {
      target: 'tool',
      name: 'emit_candidate',
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } } },
    },
  ],
};

test('prints usage and exits 2 when required arguments are missing', () => {
  const result = runValidator([]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: node ktx\/scripts\/validate-llm-debug-jsonl\.mjs anthropic\|vertex/);
});

test('accepts sanitized debug JSONL with message, message-part, and tool cache markers', () => {
  const filePath = writeDebugJsonl([validRecord]);
  const result = runValidator(['anthropic', filePath]);

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.backend, 'anthropic');
  assert.equal(parsed.records, 1);
  assert.equal(parsed.providerOptionEntries, 3);
  assert.equal(parsed.cacheMarkerEntries, 3);
  assert.deepEqual(parsed.markerTargets, ['message', 'message-part', 'tool']);
  assert.deepEqual(parsed.ttlValues, ['1h', '5m']);
});

test('rejects debug JSONL that lacks nested message-part cache marker evidence', () => {
  const filePath = writeDebugJsonl([
    {
      ...validRecord,
      providerOptions: validRecord.providerOptions.filter((entry) => entry.target !== 'message-part'),
    },
  ]);
  const result = runValidator(['anthropic', filePath]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing cacheControl marker target: message-part/);
});

test('rejects prompt-shaped fields in debug JSONL', () => {
  const filePath = writeDebugJsonl([{ ...validRecord, text: 'SECRET PROMPT' }]);
  const result = runValidator(['anthropic', filePath]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /prompt, schema, credential, or token-shaped field/);
});

test('rejects direct-Anthropic extended cache beta header in Vertex debug summaries', () => {
  const filePath = writeDebugJsonl([
    {
      ...validRecord,
      providerOptions: [
        ...validRecord.providerOptions,
        {
          target: 'message',
          index: 0,
          role: 'system',
          providerOptions: { header: 'extended-cache-ttl-2025-04-11' },
        },
      ],
    },
  ]);
  const result = runValidator(['vertex', filePath]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /direct-Anthropic extended cache TTL beta header/);
});
