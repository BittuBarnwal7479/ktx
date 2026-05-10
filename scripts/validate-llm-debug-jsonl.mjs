#!/usr/bin/env node

import { readFileSync } from 'node:fs';

const [backend, filePath] = process.argv.slice(2);

function usage() {
  process.stderr.write('Usage: node ktx/scripts/validate-llm-debug-jsonl.mjs anthropic|vertex /path/to/debug.jsonl\n');
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (!['anthropic', 'vertex'].includes(backend) || !filePath) {
  usage();
  process.exit(2);
}

const raw = readFileSync(filePath, 'utf8').trim();
if (!raw) {
  fail(`debug JSONL is empty: ${filePath}`);
}

const records = raw.split(/\n+/).map((line, index) => {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`line ${index + 1} is not valid JSON: ${error.message}`);
  }
});

const serialized = JSON.stringify(records);
const bannedKeyPattern = /"(content|text|prompt|toolSchema|parameters|apiKey|api_key|password|token)"\s*:/i;
if (bannedKeyPattern.test(serialized)) {
  fail('debug JSONL contains a prompt, schema, credential, or token-shaped field');
}

const providerOptionEntries = records.flatMap((record) => {
  if (!Array.isArray(record.providerOptions)) {
    throw new Error(`record ${record.operationName ?? '<unknown>'} is missing providerOptions array`);
  }
  return record.providerOptions;
});

const cacheMarkerEntries = providerOptionEntries.filter((entry) => {
  return JSON.stringify(entry.providerOptions).includes('"cacheControl"');
});

if (cacheMarkerEntries.length === 0) {
  fail('no cacheControl providerOptions were recorded');
}

const requiredMarkerTargets = ['message', 'message-part', 'tool'];
const markerTargets = new Set(cacheMarkerEntries.map((entry) => entry.target));
for (const target of requiredMarkerTargets) {
  if (!markerTargets.has(target)) {
    fail(`missing cacheControl marker target: ${target}`);
  }
}

const ttlValues = new Set();
for (const marker of cacheMarkerEntries) {
  const markerJson = JSON.stringify(marker.providerOptions);
  for (const match of markerJson.matchAll(/"ttl":"([^"]+)"/g)) {
    ttlValues.add(match[1]);
  }
}

if (ttlValues.size === 0) {
  fail('cacheControl markers did not expose ttl values');
}

for (const ttl of ttlValues) {
  if (ttl !== '1h' && ttl !== '5m') {
    fail(`unexpected cache ttl: ${ttl}`);
  }
}

if (backend === 'vertex' && !ttlValues.has('1h')) {
  fail('vertex debug capture did not include a default 1h cache marker');
}

if (backend === 'vertex' && serialized.includes('extended-cache-ttl-2025-04-11')) {
  fail('vertex debug capture included the direct-Anthropic extended cache TTL beta header');
}

process.stdout.write(
  `${JSON.stringify({
    backend,
    records: records.length,
    providerOptionEntries: providerOptionEntries.length,
    cacheMarkerEntries: cacheMarkerEntries.length,
    markerTargets: [...markerTargets].sort(),
    ttlValues: [...ttlValues].sort(),
  })}\n`,
);
