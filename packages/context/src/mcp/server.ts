import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { MemoryAgentInput } from '../memory/index.js';
import { jsonErrorToolResult, jsonToolResult, registerKtxContextTools } from './context-tools.js';
import type { KtxMcpServerDeps, KtxMcpServerLike, MemoryCapturePort } from './types.js';

const memoryCaptureInputSchema = {
  userMessage: z.string().min(1).describe('The user message that may contain durable knowledge.'),
  assistantMessage: z.string().optional().describe('The assistant response that concluded the exchange.'),
  connectionId: z.string().min(1).optional().describe('Optional connection id for semantic-layer capture.'),
};

const memoryCaptureStatusInputSchema = {
  runId: z.string().min(1).describe('The memory capture run id returned by memory_capture.'),
};

function registerMemoryCaptureTools(deps: {
  server: KtxMcpServerLike;
  memoryCapture: MemoryCapturePort;
  userContext: KtxMcpServerDeps['userContext'];
}): void {
  deps.server.registerTool(
    'memory_capture',
    {
      title: 'Memory Capture',
      description:
        'Capture durable knowledge and semantic-layer updates from the final user/assistant exchange. Returns a run id for polling.',
      inputSchema: memoryCaptureInputSchema,
    },
    async (input) => {
      const captureInput: MemoryAgentInput = {
        userId: deps.userContext.userId,
        chatId: `mcp-${randomUUID()}`,
        userMessage: String(input.userMessage),
        assistantMessage: typeof input.assistantMessage === 'string' ? input.assistantMessage : undefined,
        connectionId: typeof input.connectionId === 'string' ? input.connectionId : undefined,
        sourceType: 'external_ingest',
      };
      const result = await deps.memoryCapture.capture(captureInput);
      return jsonToolResult(result);
    },
  );

  deps.server.registerTool(
    'memory_capture_status',
    {
      title: 'Memory Capture Status',
      description: 'Read the current or final status for a memory capture run.',
      inputSchema: memoryCaptureStatusInputSchema,
    },
    async (input) => {
      const runId = String(input.runId);
      const status = await deps.memoryCapture.status(runId);
      return status ? jsonToolResult(status) : jsonErrorToolResult(`Memory capture run "${runId}" was not found.`);
    },
  );
}

export function createKtxMcpServer(deps: KtxMcpServerDeps): KtxMcpServerDeps['server'] {
  if (deps.memoryCapture) {
    registerMemoryCaptureTools({
      server: deps.server,
      memoryCapture: deps.memoryCapture,
      userContext: deps.userContext,
    });
  }

  if (deps.contextTools) {
    registerKtxContextTools({
      server: deps.server,
      ports: deps.contextTools,
      userContext: deps.userContext,
    });
  }

  return deps.server;
}

export function createDefaultKtxMcpServer(
  deps: Omit<KtxMcpServerDeps, 'server'> & { name?: string; version?: string },
): McpServer {
  const server = new McpServer({
    name: deps.name ?? 'ktx',
    version: deps.version ?? '0.0.0-private',
  });
  createKtxMcpServer({
    server: server as KtxMcpServerLike,
    memoryCapture: deps.memoryCapture,
    userContext: deps.userContext,
    contextTools: deps.contextTools,
  });
  return server;
}
