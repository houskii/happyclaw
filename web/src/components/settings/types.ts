// ─── 统一供应商类型 (V4) ─────────────────────────────────────

export interface UnifiedProviderPublic {
  id: string;
  name: string;
  type: 'official' | 'third_party';
  enabled: boolean;
  weight: number;
  anthropicBaseUrl: string;
  anthropicModel: string;
  hasAnthropicAuthToken: boolean;
  anthropicAuthTokenMasked: string | null;
  hasAnthropicApiKey: boolean;
  anthropicApiKeyMasked: string | null;
  hasClaudeCodeOauthToken: boolean;
  claudeCodeOauthTokenMasked: string | null;
  hasClaudeOAuthCredentials: boolean;
  claudeOAuthCredentialsExpiresAt: number | null;
  claudeOAuthCredentialsAccessTokenMasked: string | null;
  customEnv: Record<string, string>;
  updatedAt: string;
}

export interface ProviderHealthStatus {
  profileId: string;
  healthy: boolean;
  consecutiveErrors: number;
  lastErrorAt: number | null;
  lastSuccessAt: number | null;
  unhealthySince: number | null;
  activeSessionCount: number;
}

export interface ProviderWithHealth extends UnifiedProviderPublic {
  health: ProviderHealthStatus | null;
}

export interface BalancingConfig {
  strategy: 'round-robin' | 'weighted-round-robin' | 'failover';
  unhealthyThreshold: number;
  recoveryIntervalMs: number;
}

export interface ProvidersListResponse {
  providers: ProviderWithHealth[];
  balancing: BalancingConfig;
  enabledCount: number;
}

export interface ClaudeApplyResult {
  success: boolean;
  stoppedCount: number;
  failedCount?: number;
  error?: string;
}

// ─── 兼容旧类型（仍被 GET /claude 返回） ────────────────────

export interface ClaudeConfigPublic {
  anthropicBaseUrl: string;
  anthropicModel: string;
  updatedAt: string | null;
  hasAnthropicAuthToken: boolean;
  hasAnthropicApiKey: boolean;
  hasClaudeCodeOauthToken: boolean;
  anthropicAuthTokenMasked: string | null;
  anthropicApiKeyMasked: string | null;
  claudeCodeOauthTokenMasked: string | null;
  hasClaudeOAuthCredentials: boolean;
  claudeOAuthCredentialsExpiresAt: number | null;
  claudeOAuthCredentialsAccessTokenMasked: string | null;
}

// ─── 通用类型 ────────────────────────────────────────────────

export interface EnvRow {
  key: string;
  value: string;
}

export interface SessionInfo {
  id: string;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
  last_active_at: string;
  is_current: boolean;
}

export interface SettingsNotification {
  setNotice: (value: string | null) => void;
  setError: (value: string | null) => void;
}

export interface SystemSettings {
  containerTimeout: number;
  idleTimeout: number;
  containerMaxOutputSize: number;
  maxConcurrentContainers: number;
  maxConcurrentHostProcesses: number;
  maxLoginAttempts: number;
  loginLockoutMinutes: number;
  maxConcurrentScripts: number;
  scriptTimeout: number;
  skillAutoSyncEnabled: boolean;
  skillAutoSyncIntervalMinutes: number;
  billingEnabled: boolean;
  billingMode: 'wallet_first';
  billingMinStartBalanceUsd: number;
  billingCurrency: string;
  billingCurrencyRate: number;
  memoryQueryTimeout: number;
  memoryGlobalSleepTimeout: number;
  memorySendTimeout: number;
  turnBatchWindowMs: number;
  turnMaxBatchMs: number;
  traceRetentionDays: number;
  webPublicUrl: string;
  defaultLlmProvider: 'claude' | 'openai';
  defaultAnthropicModel: string;
  defaultOpenaiModel: string;
  anthropicUsageApiUrl: string;
  openaiUsageApiUrl: string;
  anthropicSdkBaseUrl: string;
  openaiSdkBaseUrl: string;
  hostIntegrationSources: HostIntegrationSource[];
  defaultClaudeModel?: string;
  defaultCodexModel?: string;
  claudeUsageApiUrl?: string;
  codexUsageApiUrl?: string;
  claudeSdkBaseUrl?: string;
  codexSdkBaseUrl?: string;
}

export type HostIntegrationSourceKind = 'provider-default' | 'custom';
export type HostIntegrationProvider = 'anthropic' | 'openai';
export type HostIntegrationStatusType = 'ok' | 'missing' | 'unreadable' | 'invalid';

export interface HostIntegrationSource {
  id: string;
  kind: HostIntegrationSourceKind;
  provider?: HostIntegrationProvider;
  label: string;
  path: string;
  enabled: boolean;
  skillsEnabled: boolean;
  mcpEnabled: boolean;
}

export interface HostIntegrationSourceStatus extends HostIntegrationSource {
  status: HostIntegrationStatusType;
  message: string | null;
}

export interface HostIntegrationSectionSnapshot {
  lastSyncAt: string | null;
  syncedCount: number;
}

export interface HostIntegrationsResponse {
  sources: HostIntegrationSourceStatus[];
  skills: HostIntegrationSectionSnapshot;
  mcp: HostIntegrationSectionSnapshot;
}

export interface HostIntegrationSyncStats {
  added: number;
  updated: number;
  deleted: number;
  skipped: number;
}

export interface HostIntegrationSyncSectionResult {
  total: number;
  stats: HostIntegrationSyncStats;
}

export interface HostIntegrationsSyncResponse {
  statuses: HostIntegrationSourceStatus[];
  skills: HostIntegrationSyncSectionResult;
  mcp: HostIntegrationSyncSectionResult;
}

export type SettingsTab = 'providers' | 'claude' | 'codex' | 'registration' | 'appearance' | 'system' | 'profile' | 'my-channels' | 'security' | 'groups' | 'memory' | 'skills' | 'mcp-servers' | 'agent-definitions' | 'users' | 'about' | 'bindings' | 'usage' | 'monitor';

// ─── Codex Provider Types ───────────────────────────────────────

export interface CodexConfigPublic {
  mode: 'cli' | 'api_key';
  hasCliAuth: boolean;
  cliAuthMode: string | null;
  cliAuthAccountId: string | null;
  cliAuthLastRefresh: string | null;
  hasEnvApiKey: boolean;
}

export interface CodexProfileItem {
  id: string;
  name: string;
  baseUrl: string;
  defaultModel: string;
  updatedAt: string | null;
  hasOpenaiApiKey: boolean;
  openaiApiKeyMasked: string | null;
  customEnv: Record<string, string>;
}

export interface CodexProfilesResp {
  activeProfileId: string;
  profiles: CodexProfileItem[];
}

export interface CodexActivateResult {
  success: boolean;
  alreadyActive?: boolean;
  activeProfileId: string;
  profile: CodexProfileItem | null;
  stoppedCount: number;
  failedCount: number;
  error?: string;
}

export interface LocalCodexCliStatus {
  detected: boolean;
  hasAuth: boolean;
  authMode: string | null;
  accountId: string | null;
  lastRefresh: string | null;
}

// ─── Codex Rate Limits ─────────────────────────────────────

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number;
}

export interface CodexRateLimitCredits {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string;
}

export interface CodexRateLimitData {
  limitId: string | null;
  planType: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  credits: CodexRateLimitCredits | null;
}

export type CodexRateLimitsResponse =
  | { available: true; rateLimits: CodexRateLimitData }
  | { available: false; reason: string };

export function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.trim()) return msg;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
