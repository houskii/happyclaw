import { getSystemSettings } from '../runtime-config.js';
import type { RegisteredGroup } from '../types.js';
import type {
  ProviderAdapter,
  ProviderId,
  WorkspaceLlmProvider,
} from './types.js';

class ProviderRegistry {
  private adapters = new Map<ProviderId, ProviderAdapter>();

  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: ProviderId): ProviderAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Unknown provider: ${id}`);
    return adapter;
  }
}

const claudeAdapter: ProviderAdapter = {
  id: 'claude',
  toWorkspaceProvider: () => 'claude',
  getDefaultModel: (settings) => settings.defaultClaudeModel || '',
  getUsageApiUrl: (settings) =>
    settings.claudeUsageApiUrl || 'https://api.anthropic.com/api/oauth/usage',
};

const codexAdapter: ProviderAdapter = {
  id: 'codex',
  toWorkspaceProvider: () => 'openai',
  getDefaultModel: (settings) => settings.defaultCodexModel || '',
  getUsageApiUrl: (settings) => settings.codexUsageApiUrl || '',
};

const registry = new ProviderRegistry();
registry.register(claudeAdapter);
registry.register(codexAdapter);

export function resolveProviderId(
  llmProvider: WorkspaceLlmProvider | undefined,
): ProviderId {
  return llmProvider === 'openai' ? 'codex' : 'claude';
}

export function resolveDefaultLlmBindingFromSystem(): Pick<
  RegisteredGroup,
  'llm_provider' | 'model'
> {
  const settings = getSystemSettings();
  const providerId: ProviderId =
    settings.defaultLlmProvider === 'openai' ? 'codex' : 'claude';
  const adapter = registry.get(providerId);
  const model = adapter.getDefaultModel(settings).trim();
  return {
    llm_provider: adapter.toWorkspaceProvider(),
    model: model || undefined,
  };
}

export function getProviderDefaultModel(
  providerId: ProviderId,
  settings = getSystemSettings(),
): string {
  return registry.get(providerId).getDefaultModel(settings).trim();
}

export function getProviderUsageApiUrl(
  providerId: ProviderId,
  settings = getSystemSettings(),
): string {
  return registry.get(providerId).getUsageApiUrl(settings).trim();
}

