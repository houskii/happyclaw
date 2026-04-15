/**
 * Lightweight Codex wrapper for simple text-in → text-out queries.
 *
 * Uses the same local Codex provider configuration as HappyClaw host mode:
 * - `api_key` mode → pass API key/baseUrl explicitly
 * - `cli` mode → rely on local `CODEX_HOME/auth.json`
 */

import path from 'path';
import { pathToFileURL } from 'url';

import {
  getCodexProviderConfig,
  getSystemSettings,
} from './runtime-config.js';
import { getCodexHomeDir } from './codex-app-handoff.js';
import { logger } from './logger.js';

type CodexCtor = new (options?: {
  apiKey?: string;
  baseUrl?: string;
  config?: Record<string, string>;
  env?: Record<string, string>;
}) => {
  startThread: (options?: Record<string, unknown>) => {
    run: (
      input: string,
      turnOptions?: { signal?: AbortSignal },
    ) => Promise<{ finalResponse: string }>;
  };
};

let cachedCodexCtor: CodexCtor | null = null;

async function loadCodexCtor(): Promise<CodexCtor> {
  if (cachedCodexCtor) return cachedCodexCtor;

  const modPath = path.resolve(
    process.cwd(),
    'container/agent-runner/node_modules/@openai/codex-sdk/dist/index.js',
  );
  const mod = await import(pathToFileURL(modPath).href) as { Codex: CodexCtor };
  cachedCodexCtor = mod.Codex;
  return cachedCodexCtor;
}

export async function codexQuery(
  prompt: string,
  opts?: {
    model?: string;
    timeout?: number;
    cwd?: string;
    reasoningEffort?: string;
    serviceTier?: string;
  },
): Promise<string | null> {
  const timeout = opts?.timeout ?? 60_000;
  const cwd = opts?.cwd || process.cwd();

  try {
    const Codex = await loadCodexCtor();
    const config = getCodexProviderConfig();
    const settings = getSystemSettings();
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      CODEX_HOME: getCodexHomeDir(),
    };

    const codexOptions: {
      apiKey?: string;
      baseUrl?: string;
      config?: Record<string, string>;
      env: Record<string, string>;
    } = { env };

    if (config.mode === 'api_key') {
      const apiKey = config.activeProfile?.openaiApiKey || process.env.OPENAI_API_KEY;
      if (apiKey) codexOptions.apiKey = apiKey;
      if (config.activeProfile?.baseUrl) codexOptions.baseUrl = config.activeProfile.baseUrl;
    } else {
      delete codexOptions.env.OPENAI_API_KEY;
      delete codexOptions.env.OPENAI_BASE_URL;
    }

    const serviceTier = opts?.serviceTier || settings.defaultCodexServiceTier || undefined;
    if (serviceTier) {
      codexOptions.config = { service_tier: serviceTier };
    }

    const codex = new Codex(codexOptions);
    const thread = codex.startThread({
      model: opts?.model || settings.defaultCodexModel || undefined,
      workingDirectory: cwd,
      skipGitRepoCheck: true,
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      ...(opts?.reasoningEffort
        ? { modelReasoningEffort: opts.reasoningEffort }
        : settings.defaultCodexThinkingEffort
          ? { modelReasoningEffort: settings.defaultCodexThinkingEffort }
        : {}),
    });

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeout);
    try {
      const result = await thread.run(prompt, { signal: abort.signal });
      return result.finalResponse?.trim() || null;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'codexQuery failed',
    );
    return null;
  }
}
