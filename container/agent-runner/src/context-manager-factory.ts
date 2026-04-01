/**
 * Shared ContextManager factory — single source of truth for plugin registration.
 *
 * Both Claude and Codex runners call this to get a consistently configured
 * ContextManager. Provider-specific differences are controlled via options.
 */

import {
  ContextManager,
  MessagingPlugin,
  TasksPlugin,
  GroupsPlugin,
  MemoryPlugin,
  SkillsPlugin,
  type PluginContext,
} from 'happyclaw-agent-runner-core';
import { InvokeAgentPlugin } from './plugins/invoke-agent-plugin.js';

// ─── Options ─────────────────────────────────────────────────

export interface ContextManagerOptions {
  /** Register SkillsPlugin (Codex needs it; Claude has native skill support). */
  includeSkills?: boolean;
  /** Backend API URL. Defaults to HAPPYCLAW_API_URL or http://localhost:3000. */
  apiUrl?: string;
  /** Backend API token. Defaults to HAPPYCLAW_INTERNAL_TOKEN. */
  apiToken?: string;
  /** Memory query timeout in ms. Defaults to HAPPYCLAW_MEMORY_QUERY_TIMEOUT or 60000. */
  memoryQueryTimeoutMs?: number;
  /** Memory send timeout in ms. Defaults to HAPPYCLAW_MEMORY_SEND_TIMEOUT or 120000. */
  memorySendTimeoutMs?: number;
}

// ─── Factory ─────────────────────────────────────────────────

export function createContextManager(
  ctx: PluginContext,
  options?: ContextManagerOptions,
): ContextManager {
  const apiUrl = options?.apiUrl
    ?? process.env.HAPPYCLAW_API_URL
    ?? 'http://localhost:3000';
  const apiToken = options?.apiToken
    ?? process.env.HAPPYCLAW_INTERNAL_TOKEN
    ?? '';
  const memoryQueryTimeoutMs = options?.memoryQueryTimeoutMs
    ?? parseInt(process.env.HAPPYCLAW_MEMORY_QUERY_TIMEOUT || '60000', 10);
  const memorySendTimeoutMs = options?.memorySendTimeoutMs
    ?? parseInt(process.env.HAPPYCLAW_MEMORY_SEND_TIMEOUT || '120000', 10);

  const ctxMgr = new ContextManager(ctx);

  // ── Always-on plugins ──
  ctxMgr.register(new MessagingPlugin());
  ctxMgr.register(new TasksPlugin());
  ctxMgr.register(new GroupsPlugin());

  // ── Skills (Codex only — Claude SDK has native skill support) ──
  if (options?.includeSkills) {
    ctxMgr.register(new SkillsPlugin());
  }

  // ── Memory (requires userId to be meaningful) ──
  if (ctx.userId) {
    ctxMgr.register(new MemoryPlugin({
      apiUrl,
      apiToken,
      queryTimeoutMs: memoryQueryTimeoutMs,
      sendTimeoutMs: memorySendTimeoutMs,
    }));
  }

  // ── Invoke Agent (cross-provider sub-agent calls) ──
  ctxMgr.register(new InvokeAgentPlugin());

  return ctxMgr;
}
