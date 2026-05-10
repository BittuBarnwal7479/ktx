import { execFile } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const CLI_BIN = resolve(process.cwd(), 'dist/bin.js');
const EXAMPLE_DIR = resolve(process.cwd(), '../../examples/local-warehouse');

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface ExecFailure extends Error {
  code?: number;
  stdout?: string;
  stderr?: string;
}

function isExecFailure(error: unknown): error is ExecFailure {
  return error instanceof Error && ('stdout' in error || 'stderr' in error || 'code' in error);
}

async function runBuiltCli(args: string[]): Promise<CliResult> {
  try {
    const result = await execFileAsync(process.execPath, [CLI_BIN, ...args], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    return {
      code: 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    if (!isExecFailure(error)) {
      throw error;
    }
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? error.message,
    };
  }
}

function structuredContent<T extends object>(result: unknown): T {
  const content = (result as { structuredContent?: unknown }).structuredContent;
  expect(content).toBeDefined();
  return content as T;
}

function parseJsonOutput<T>(stdout: string): T {
  return JSON.parse(stdout) as T;
}

async function copyExampleProject(tempDir: string): Promise<string> {
  const projectDir = join(tempDir, 'local-warehouse');
  await cp(EXAMPLE_DIR, projectDir, { recursive: true });
  return projectDir;
}

describe('standalone local warehouse example', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-example-smoke-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('runs local CLI commands against the copied example project', async () => {
    const projectDir = await copyExampleProject(tempDir);
    const sourceDir = join(projectDir, 'source');

    const knowledgeList = await runBuiltCli(['agent', 'wiki', 'search', 'revenue', '--json', '--project-dir', projectDir]);
    expect(knowledgeList).toMatchObject({ code: 0, stderr: '' });
    expect(parseJsonOutput<{ results: Array<{ key: string; summary: string }> }>(knowledgeList.stdout).results).toContainEqual(
      expect.objectContaining({ key: 'revenue', summary: 'Paid order value after refunds' }),
    );

    const knowledgeRead = await runBuiltCli(['agent', 'wiki', 'read', 'revenue', '--json', '--project-dir', projectDir]);
    expect(knowledgeRead).toMatchObject({ code: 0, stderr: '' });
    expect(parseJsonOutput<{ content: string }>(knowledgeRead.stdout).content).toContain(
      'Revenue is paid order amount after refund adjustments.',
    );

    const slList = await runBuiltCli(['agent', 'sl', 'list', '--json', '--project-dir', projectDir, '--connection-id', 'warehouse']);
    expect(slList).toMatchObject({ code: 0, stderr: '' });
    expect(parseJsonOutput<{ sources: Array<{ connectionId: string; name: string; columnCount: number }> }>(slList.stdout).sources).toContainEqual(
      expect.objectContaining({ connectionId: 'warehouse', name: 'orders', columnCount: 3 }),
    );

    const slRead = await runBuiltCli([
      'agent',
      'sl',
      'read',
      'orders',
      '--json',
      '--connection-id',
      'warehouse',
      '--project-dir',
      projectDir,
    ]);
    expect(slRead).toMatchObject({ code: 0, stderr: '' });
    expect(parseJsonOutput<{ yaml: string }>(slRead.stdout).yaml).toContain('name: orders');

    const ingest = await runBuiltCli([
      'dev',
      'ingest',
      'run',
      '--project-dir',
      projectDir,
      '--connection-id',
      'warehouse',
      '--adapter',
      'fake',
      '--source-dir',
      sourceDir,
    ]);
    expect(ingest).toMatchObject({ code: 1, stdout: '' });
    expect(ingest.stderr).toContain(
      'ktx dev ingest run requires llm.provider.backend: anthropic, vertex, or gateway, or an injected agentRunner',
    );
  }, 30_000);

  it('serves local wiki and semantic-layer MCP tools against the copied example project', async () => {
    const projectDir = await copyExampleProject(tempDir);

    const client = new Client({ name: 'ktx-example-client', version: '0.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_BIN, 'serve', '--mcp', 'stdio', '--project-dir', projectDir, '--user-id', 'example-user'],
      stderr: 'pipe',
    });

    try {
      await client.connect(transport);

      const knowledgeSearch = structuredContent<{
        results: Array<{ key: string; summary: string; score: number }>;
        totalFound: number;
      }>(
        await client.callTool({
          name: 'knowledge_search',
          arguments: { query: 'refund', limit: 5 },
        }),
      );
      expect(knowledgeSearch.totalFound).toBe(1);
      expect(knowledgeSearch.results[0]).toMatchObject({
        key: 'revenue',
        summary: 'Paid order value after refunds',
      });

      const knowledgeRead = structuredContent<{ key: string; summary: string; content: string; scope: string }>(
        await client.callTool({ name: 'knowledge_read', arguments: { key: 'revenue' } }),
      );
      expect(knowledgeRead).toMatchObject({
        key: 'revenue',
        summary: 'Paid order value after refunds',
        scope: 'GLOBAL',
      });
      expect(knowledgeRead.content).toContain('Revenue is paid order amount after refund adjustments.');

      const knowledgeWrite = structuredContent<{ success: boolean; key: string; action: string }>(
        await client.callTool({
          name: 'knowledge_write',
          arguments: {
            key: 'gross_margin',
            summary: 'Revenue after direct costs',
            content: 'Gross margin subtracts direct order costs from revenue.',
            tags: ['finance'],
            sl_refs: ['warehouse.orders'],
          },
        }),
      );
      expect(knowledgeWrite).toEqual({ success: true, key: 'gross_margin', action: 'created' });

      const slList = structuredContent<{
        sources: Array<{
          connectionId: string;
          name: string;
          description?: string;
          columnCount: number;
          measureCount: number;
          joinCount: number;
        }>;
        totalSources: number;
      }>(await client.callTool({ name: 'sl_list_sources', arguments: { connectionId: 'warehouse' } }));
      expect(slList.totalSources).toBe(1);
      expect(slList.sources[0]).toMatchObject({
        connectionId: 'warehouse',
        name: 'orders',
        description: 'Orders placed through the storefront.',
        columnCount: 3,
        measureCount: 2,
        joinCount: 0,
      });

      const slRead = structuredContent<{ sourceName: string; yaml: string }>(
        await client.callTool({
          name: 'sl_read_source',
          arguments: { connectionId: 'warehouse', sourceName: 'orders' },
        }),
      );
      expect(slRead.sourceName).toBe('orders');
      expect(slRead.yaml).toContain('name: orders');
      expect(slRead.yaml).toContain('total_revenue');

      const slWrite = structuredContent<{ success: boolean; sourceName: string }>(
        await client.callTool({
          name: 'sl_write_source',
          arguments: {
            connectionId: 'warehouse',
            sourceName: 'customers',
            source: {
              name: 'customers',
              table: 'public.customers',
              grain: ['id'],
              columns: [{ name: 'id', type: 'number' }],
              joins: [],
              measures: [],
            },
          },
        }),
      );
      expect(slWrite).toMatchObject({ success: true, sourceName: 'customers' });

      const slValidate = structuredContent<{ success: boolean; errors: string[]; warnings: string[] }>(
        await client.callTool({
          name: 'sl_validate',
          arguments: { connectionId: 'warehouse', names: ['orders', 'customers'] },
        }),
      );
      expect(slValidate.success).toBe(true);
      expect(slValidate.errors).toEqual([]);
      expect(slValidate.warnings).toContain(
        'Local stdio validation checks YAML shape only; Python semantic validation is not configured.',
      );
    } finally {
      await client.close();
    }
  }, 30_000);
});
