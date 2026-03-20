/**
 * MemoryPlugin — memory_query, memory_remember tools.
 *
 * Communicates with the Memory Agent via HTTP endpoints on the main process.
 */

import fs from 'fs';
import path from 'path';
import type { ContextPlugin, PluginContext, ToolDefinition, ToolResult } from '../plugin.js';

export interface MemoryPluginOptions {
  apiUrl: string;
  apiToken: string;
  /** Timeout for memory_query in ms (env: HAPPYCLAW_MEMORY_QUERY_TIMEOUT, default 60000). */
  queryTimeoutMs: number;
  /** Timeout for memory_remember in ms (env: HAPPYCLAW_MEMORY_SEND_TIMEOUT, default 120000). */
  sendTimeoutMs: number;
  /** Path to the memory index file (e.g., data/memory/{userId}/index.md). */
  memoryIndexPath?: string;
}

export class MemoryPlugin implements ContextPlugin {
  readonly name = 'memory';
  private opts: MemoryPluginOptions;

  constructor(opts: MemoryPluginOptions) {
    this.opts = opts;
  }

  isEnabled(ctx: PluginContext): boolean {
    return !!ctx.userId;
  }

  getTools(ctx: PluginContext): ToolDefinition[] {
    return [
      // --- memory_query ---
      {
        name: 'memory_query',
        description: '向记忆系统查询。可以问关于过去对话、用户信息、项目知识的任何问题。查询可能需要几秒钟。',
        parameters: {
          type: 'object' as const,
          properties: {
            query: { type: 'string', description: '查询内容' },
            context: { type: 'string', description: '当前对话的简要上下文，帮助记忆系统更准确地搜索' },
            channel: { type: 'string', description: '消息来源渠道（取自 source 属性），用于定位对话上下文' },
          },
          required: ['query'],
        },
        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
          const result = await this.callMemoryAgent('/query', {
            userId: ctx.userId,
            query: args.query,
            context: args.context || '',
            chatJid: (args.channel as string) || ctx.chatJid,
            groupFolder: ctx.groupFolder,
          }, this.opts.queryTimeoutMs);

          if (!result.ok) {
            return { content: result.errorMsg, isError: true };
          }
          return { content: (result.data.response as string) || '没有找到相关记忆。' };
        },
      },

      // --- memory_remember ---
      {
        name: 'memory_remember',
        description: '告诉记忆系统记住某条信息。用户说「记住」或发现重要信息时使用。',
        parameters: {
          type: 'object' as const,
          properties: {
            content: { type: 'string', description: '需要记住的内容' },
            importance: {
              type: 'string',
              enum: ['high', 'normal'],
              description: '重要性级别，默认 normal',
            },
            channel: { type: 'string', description: '消息来源渠道（取自 source 属性），用于定位对话上下文' },
          },
          required: ['content'],
        },
        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
          const result = await this.callMemoryAgent('/remember', {
            userId: ctx.userId,
            content: args.content,
            importance: (args.importance as string) || 'normal',
            chatJid: (args.channel as string) || ctx.chatJid,
            groupFolder: ctx.groupFolder,
          }, this.opts.sendTimeoutMs);

          if (!result.ok) {
            return { content: result.errorMsg, isError: true };
          }
          return { content: '已通知记忆系统。' };
        },
      },
    ];
  }

  getSystemPromptSection(ctx: PluginContext): string {
    const parts: string[] = [];
    parts.push('## 记忆系统', '');
    parts.push('你拥有记忆能力，可通过 memory_query 查询过去的对话和知识，通过 memory_remember 记住重要信息。');
    parts.push('');

    // Load memory index if available
    const indexPath = this.opts.memoryIndexPath
      || path.join(ctx.workspaceMemory, 'index.md');
    try {
      if (fs.existsSync(indexPath)) {
        const indexContent = fs.readFileSync(indexPath, 'utf-8').trim();
        if (indexContent) {
          parts.push('### 记忆索引（随身携带）', '', indexContent, '');
        }
      }
    } catch { /* ignore */ }

    // Load personality if available
    const personalityPath = path.join(ctx.workspaceMemory, 'personality.md');
    try {
      if (fs.existsSync(personalityPath)) {
        const personality = fs.readFileSync(personalityPath, 'utf-8').trim();
        if (personality) {
          parts.push('### 用户交互模式', '', personality, '');
        }
      }
    } catch { /* ignore */ }

    return parts.join('\n');
  }

  // ─── Private helpers ────────────────────────────────────────

  private async callMemoryAgent(
    endpoint: string,
    body: object,
    timeoutMs: number,
  ): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; status: number; errorMsg: string }> {
    const controller = new AbortController();
    const httpTimeout = (Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60000) + 5000;
    const timer = setTimeout(() => controller.abort(), httpTimeout);

    try {
      const res = await fetch(`${this.opts.apiUrl}/api/internal/memory${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.opts.apiToken}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        const status = res.status;
        let errorMsg = '记忆系统暂时不可用';
        if (status === 408) errorMsg = '记忆系统处理超时，你可以直接告诉我相关信息';
        else if (status === 502) errorMsg = '记忆系统出了点问题，不过不影响我们继续聊';
        else if (status === 503) errorMsg = '上一个记忆查询还在处理中，稍等一下';
        return { ok: false, status, errorMsg };
      }

      const data = await res.json();
      return { ok: true, data };
    } catch (err) {
      clearTimeout(timer);
      const errorMsg = err instanceof Error && err.name === 'AbortError'
        ? '记忆查询超时'
        : '无法连接记忆系统';
      return { ok: false, status: 0, errorMsg };
    }
  }
}
