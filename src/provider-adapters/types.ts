import type { SystemSettings } from '../runtime-config.js';

export type ProviderId = 'claude' | 'codex';
export type WorkspaceLlmProvider = 'claude' | 'openai';

export interface ProviderAdapter {
  id: ProviderId;
  toWorkspaceProvider(): WorkspaceLlmProvider;
  getDefaultModel(settings: SystemSettings): string;
  getUsageApiUrl(settings: SystemSettings): string;
}

