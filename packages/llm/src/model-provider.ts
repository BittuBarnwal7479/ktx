import { createAnthropic } from '@ai-sdk/anthropic';
import { createVertexAnthropic } from '@ai-sdk/google-vertex/anthropic';
import { createGateway, generateText, type LanguageModel } from 'ai';
import { createKtxToolCallRepairHandler } from './repair.js';
import type {
  KtxLlmConfig,
  KtxLlmProvider,
  KtxModelRole,
  KtxPromptCacheTtl,
  KtxPromptCachingConfig,
  KtxProviderOptions,
} from './types.js';

type AnthropicFactory = typeof createAnthropic;
type AnthropicModelFactory = (modelId: string) => LanguageModel;
type VertexAnthropicFactory = (options?: Parameters<typeof createVertexAnthropic>[0]) => AnthropicModelFactory;
type GatewayFactory = (options?: Parameters<typeof createGateway>[0]) => AnthropicModelFactory;

export interface KtxLlmProviderFactoryDeps {
  createAnthropic?: (options?: Parameters<AnthropicFactory>[0]) => AnthropicModelFactory;
  createVertexAnthropic?: VertexAnthropicFactory;
  createGateway?: GatewayFactory;
  generateText?: typeof generateText;
}

const DEFAULT_PROMPT_CACHING: KtxPromptCachingConfig = {
  enabled: true,
  systemTtl: '1h',
  toolsTtl: '1h',
  historyTtl: '5m',
  cacheSystem: true,
  cacheTools: true,
  cacheHistory: true,
  vertexFallbackTo5m: false,
};

const DIRECT_ANTHROPIC_BETA_HEADER = 'interleaved-thinking-2025-05-14,extended-cache-ttl-2025-04-11';

function resolvePromptCaching(config: KtxLlmConfig): KtxPromptCachingConfig {
  return { ...DEFAULT_PROMPT_CACHING, ...config.promptCaching };
}

export function modelIdFromLanguageModel(model: LanguageModel | string): string {
  return typeof model === 'string' ? model : ((model as { modelId?: string }).modelId ?? '');
}

export function isAnthropicProtocolModel(model: LanguageModel | string): boolean {
  const modelId = modelIdFromLanguageModel(model);
  return modelId.startsWith('claude-') || modelId.startsWith('anthropic/') || modelId.includes('/claude-');
}

class DefaultKtxLlmProvider implements KtxLlmProvider {
  private readonly promptCaching: KtxPromptCachingConfig;
  private readonly getModelByResolvedName: (modelId: string) => LanguageModel;
  private readonly runGenerateText: typeof generateText;

  constructor(
    private readonly config: KtxLlmConfig,
    deps: KtxLlmProviderFactoryDeps,
  ) {
    this.promptCaching = resolvePromptCaching(config);
    this.runGenerateText = deps.generateText ?? generateText;
    this.getModelByResolvedName = this.createModelFactory(config, deps);
  }

  getModel(role: KtxModelRole): LanguageModel {
    return this.getModelByName(this.resolveRole(role));
  }

  getModelByName(modelId: string): LanguageModel {
    return this.getModelByResolvedName(modelId);
  }

  cacheMarker(ttl: KtxPromptCacheTtl, model?: LanguageModel | string) {
    if (!this.promptCaching.enabled) {
      return undefined;
    }
    if (model && !isAnthropicProtocolModel(model)) {
      return undefined;
    }
    return { anthropic: { cacheControl: { type: 'ephemeral' as const, ttl } } };
  }

  repairToolCallHandler(options: { source?: string } = {}) {
    return createKtxToolCallRepairHandler({
      source: options.source ?? 'ktx-llm',
      getRepairModel: () => this.getModel('repair'),
      generateText: this.runGenerateText,
    });
  }

  thinkingProviderOptions(_role: KtxModelRole, budgetTokens: number): KtxProviderOptions {
    return {
      anthropic: {
        thinking: { type: 'enabled', budgetTokens },
      },
    };
  }

  telemetryConfig() {
    return this.config.telemetry?.experimentalTelemetry;
  }

  promptCachingConfig(): KtxPromptCachingConfig {
    return this.promptCaching;
  }

  activeBackend() {
    return this.config.backend;
  }

  private resolveRole(role: KtxModelRole): string {
    return this.config.modelSlots[role] ?? this.config.modelSlots.default;
  }

  private createModelFactory(config: KtxLlmConfig, deps: KtxLlmProviderFactoryDeps): (modelId: string) => LanguageModel {
    if (config.backend === 'anthropic') {
      const anthropic = (deps.createAnthropic ?? createAnthropic)({
        ...(config.anthropic?.apiKey ? { apiKey: config.anthropic.apiKey } : {}),
        ...(config.anthropic?.baseURL ? { baseURL: config.anthropic.baseURL } : {}),
        headers: {
          'anthropic-beta': DIRECT_ANTHROPIC_BETA_HEADER,
        },
      });
      return (modelId) => anthropic(modelId);
    }

    if (config.backend === 'vertex') {
      if (!config.vertex?.location) {
        throw new Error('vertex.location is required when KTX LLM backend is vertex');
      }
      const vertex = (deps.createVertexAnthropic ?? createVertexAnthropic)({
        ...(config.vertex.project ? { project: config.vertex.project } : {}),
        location: config.vertex.location,
      });
      return (modelId) => vertex(modelId);
    }

    const gateway = (deps.createGateway ?? createGateway)({
      ...(config.gateway?.apiKey ? { apiKey: config.gateway.apiKey } : {}),
      ...(config.gateway?.baseURL ? { baseURL: config.gateway.baseURL } : {}),
    });
    return (modelId) => gateway(modelId);
  }
}

export function createKtxLlmProvider(config: KtxLlmConfig, deps: KtxLlmProviderFactoryDeps = {}): KtxLlmProvider {
  if (!config.modelSlots.default) {
    throw new Error('modelSlots.default is required');
  }
  return new DefaultKtxLlmProvider(config, deps);
}
