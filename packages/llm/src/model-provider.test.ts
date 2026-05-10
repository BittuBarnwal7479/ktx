import type { LanguageModel } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { createKtxLlmProvider } from './model-provider.js';

const languageModel = (modelId: string, provider = 'test'): LanguageModel => ({ modelId, provider }) as LanguageModel;

describe('createKtxLlmProvider', () => {
  it('uses direct Anthropic with both beta headers', () => {
    const anthropicModel = languageModel('claude-sonnet-4-6', 'anthropic');
    const anthropic = vi.fn(() => anthropicModel);
    const createAnthropic = vi.fn(() => anthropic);

    const provider = createKtxLlmProvider(
      {
        backend: 'anthropic',
        anthropic: { apiKey: 'test-anthropic-key', baseURL: 'https://anthropic.test' }, // pragma: allowlist secret
        modelSlots: { default: 'claude-sonnet-4-6' },
        promptCaching: { enabled: false },
      },
      { createAnthropic },
    );

    expect(provider.getModel('default')).toBe(anthropicModel);
    expect(createAnthropic).toHaveBeenCalledWith({
      apiKey: 'test-anthropic-key', // pragma: allowlist secret
      baseURL: 'https://anthropic.test',
      headers: {
        'anthropic-beta': 'interleaved-thinking-2025-05-14,extended-cache-ttl-2025-04-11',
      },
    });
    expect(anthropic).toHaveBeenCalledWith('claude-sonnet-4-6');
  });

  it('uses Vertex Anthropic without the direct-Anthropic beta header', () => {
    const vertexModel = languageModel('claude-sonnet-4-6', 'vertex');
    const vertex = vi.fn(() => vertexModel);
    const createVertexAnthropic = vi.fn(() => vertex);

    const provider = createKtxLlmProvider(
      {
        backend: 'vertex',
        vertex: { project: 'ktx-test', location: 'us-east5' },
        modelSlots: { default: 'claude-sonnet-4-6' },
        promptCaching: { enabled: false },
      },
      { createVertexAnthropic },
    );

    expect(provider.getModel('default')).toBe(vertexModel);
    expect(createVertexAnthropic).toHaveBeenCalledWith({ project: 'ktx-test', location: 'us-east5' });
    expect(vertex).toHaveBeenCalledWith('claude-sonnet-4-6');
  });

  it('uses Gateway and supports role fallback to default', () => {
    const gatewayModel = languageModel('anthropic/claude-sonnet-4-6', 'gateway');
    const gateway = vi.fn(() => gatewayModel);
    const createGateway = vi.fn(() => gateway);

    const provider = createKtxLlmProvider(
      {
        backend: 'gateway',
        gateway: { apiKey: 'gateway-key', baseURL: 'https://gateway.test/v1' }, // pragma: allowlist secret
        modelSlots: { default: 'anthropic/claude-sonnet-4-6' },
        promptCaching: { enabled: false },
      },
      { createGateway },
    );

    expect(provider.getModel('curator')).toBe(gatewayModel);
    expect(createGateway).toHaveBeenCalledWith({
      apiKey: 'gateway-key', // pragma: allowlist secret
      baseURL: 'https://gateway.test/v1',
    });
    expect(gateway).toHaveBeenCalledWith('anthropic/claude-sonnet-4-6');
  });

  it('uses explicit role overrides before default', () => {
    const anthropic = vi.fn((modelId: string) => languageModel(modelId, 'anthropic'));

    const provider = createKtxLlmProvider(
      {
        backend: 'anthropic',
        anthropic: { apiKey: 'test-anthropic-key' }, // pragma: allowlist secret
        modelSlots: {
          default: 'claude-sonnet-4-6',
          triage: 'claude-haiku-4-5',
          repair: 'claude-opus-4-7',
        },
        promptCaching: { enabled: false },
      },
      { createAnthropic: vi.fn(() => anthropic) },
    );

    expect((provider.getModel('triage') as { modelId: string }).modelId).toBe('claude-haiku-4-5');
    expect((provider.getModel('repair') as { modelId: string }).modelId).toBe('claude-opus-4-7');
    expect((provider.getModel('reconcile') as { modelId: string }).modelId).toBe('claude-sonnet-4-6');
  });

  it('emits cache markers only when enabled and the model speaks Anthropic protocol', () => {
    const provider = createKtxLlmProvider(
      {
        backend: 'gateway',
        gateway: { baseURL: 'https://gateway.test/v1' },
        modelSlots: { default: 'anthropic/claude-sonnet-4-6' },
        promptCaching: { enabled: true },
      },
      { createGateway: vi.fn(() => vi.fn((modelId: string) => languageModel(modelId, 'gateway'))) },
    );

    expect(provider.cacheMarker('1h', 'anthropic/claude-sonnet-4-6')).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } },
    });
    expect(provider.cacheMarker('1h', 'gpt-5')).toBeUndefined();
  });

  it('returns Anthropic thinking provider options', () => {
    const provider = createKtxLlmProvider(
      {
        backend: 'anthropic',
        anthropic: { apiKey: 'test-anthropic-key' }, // pragma: allowlist secret
        modelSlots: { default: 'claude-sonnet-4-6' },
        promptCaching: { enabled: false },
      },
      { createAnthropic: vi.fn(() => vi.fn((modelId: string) => languageModel(modelId, 'anthropic'))) },
    );

    expect(provider.thinkingProviderOptions('default', 12000)).toEqual({
      anthropic: {
        thinking: { type: 'enabled', budgetTokens: 12000 },
      },
    });
  });

  it('defaults prompt caching to enabled with canonical TTLs', () => {
    const provider = createKtxLlmProvider(
      {
        backend: 'gateway',
        gateway: { baseURL: 'https://gateway.test/v1' },
        modelSlots: { default: 'anthropic/claude-sonnet-4-6' },
      },
      { createGateway: vi.fn(() => vi.fn((modelId: string) => languageModel(modelId, 'gateway'))) },
    );

    expect(provider.promptCachingConfig()).toEqual({
      enabled: true,
      systemTtl: '1h',
      toolsTtl: '1h',
      historyTtl: '5m',
      cacheSystem: true,
      cacheTools: true,
      cacheHistory: true,
      vertexFallbackTo5m: false,
    });
    expect(provider.cacheMarker('1h', 'anthropic/claude-sonnet-4-6')).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } },
    });
  });

  it('preserves explicit prompt caching opt-out', () => {
    const provider = createKtxLlmProvider(
      {
        backend: 'anthropic',
        anthropic: { apiKey: 'test-anthropic-key' }, // pragma: allowlist secret
        modelSlots: { default: 'claude-sonnet-4-6' },
        promptCaching: { enabled: false },
      },
      { createAnthropic: vi.fn(() => vi.fn((modelId: string) => languageModel(modelId, 'anthropic'))) },
    );

    expect(provider.promptCachingConfig().enabled).toBe(false);
    expect(provider.cacheMarker('1h', 'claude-sonnet-4-6')).toBeUndefined();
  });
});
