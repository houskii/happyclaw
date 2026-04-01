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

export interface ContextManagerOptions {
  includeSkills?: boolean;
  apiUrl?: string;
  apiToken?: string;
  memoryQueryTimeoutMs?: number;
  memorySendTimeoutMs?: number;
}

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

  ctxMgr.register(new MessagingPlugin());
  ctxMgr.register(new TasksPlugin());
  ctxMgr.register(new GroupsPlugin());

  if (options?.includeSkills) {
    ctxMgr.register(new SkillsPlugin());
  }

  if (ctx.userId) {
    ctxMgr.register(new MemoryPlugin({
      apiUrl,
      apiToken,
      queryTimeoutMs: memoryQueryTimeoutMs,
      sendTimeoutMs: memorySendTimeoutMs,
    }));
  }

  return ctxMgr;
}
