/**
 * FeishuDocsPlugin — read_feishu_document, search_feishu_docs tools.
 *
 * Communicates with the main process via HTTP to read/search Feishu documents.
 */

import type { ContextPlugin, PluginContext, ToolDefinition, ToolResult } from '../plugin.js';

export interface FeishuDocsPluginOptions {
  apiUrl: string;
  apiToken: string;
  /** HTTP timeout in ms (default 30000). */
  timeoutMs?: number;
}

export class FeishuDocsPlugin implements ContextPlugin {
  readonly name = 'feishu-docs';
  private opts: FeishuDocsPluginOptions;

  constructor(opts: FeishuDocsPluginOptions) {
    this.opts = opts;
  }

  isEnabled(ctx: PluginContext): boolean {
    return !!ctx.userId;
  }

  getTools(ctx: PluginContext): ToolDefinition[] {
    const timeoutMs = this.opts.timeoutMs || 30000;

    return [
      // --- read_feishu_document ---
      {
        name: 'read_feishu_document',
        description:
          '读取飞书文档或 Wiki 页面的内容。支持 feishu.cn 和 larkoffice.com 的 wiki/docx 链接。需要用户已在设置中完成飞书 OAuth 授权。',
        parameters: {
          type: 'object' as const,
          properties: {
            url: {
              type: 'string',
              description: '飞书文档 URL（如 https://xxx.feishu.cn/wiki/xxx 或 https://xxx.larkoffice.com/wiki/xxx）',
            },
          },
          required: ['url'],
        },
        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const res = await fetch(`${this.opts.apiUrl}/api/internal/feishu/read-document`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.opts.apiToken}`,
              },
              body: JSON.stringify({ userId: ctx.userId, url: args.url }),
              signal: controller.signal,
            });
            clearTimeout(timer);

            if (!res.ok) {
              const errBody = await res.json().catch(() => ({})) as { error?: string; code?: string };
              if (errBody.code === 'OAUTH_REQUIRED') {
                return { content: '需要先完成飞书 OAuth 授权才能读取文档。请让用户在 Web 设置页面中完成「飞书文档授权」。', isError: true };
              }
              return { content: errBody.error || '读取文档失败', isError: true };
            }

            const data = await res.json() as { title?: string; content?: string };
            const title = data.title ? `# ${data.title}\n\n` : '';
            return { content: `${title}${data.content || '（文档内容为空）'}` };
          } catch (err) {
            clearTimeout(timer);
            return {
              content: err instanceof Error && err.name === 'AbortError' ? '读取飞书文档超时' : '无法连接到飞书文档服务',
              isError: true,
            };
          }
        },
      },

      // --- search_feishu_docs ---
      {
        name: 'search_feishu_docs',
        description:
          '搜索飞书文档。根据关键词搜索云文档和 Wiki 页面，返回匹配的文档列表（标题、链接、预览）。' +
          '需要用户已在设置中完成飞书 OAuth 授权（含搜索权限）。' +
          '搜索结果中的文档可以用 read_feishu_document 工具进一步读取内容。',
        parameters: {
          type: 'object' as const,
          properties: {
            query: { type: 'string', description: '搜索关键词（不能为空）' },
            count: { type: 'number', description: '返回结果数量（默认 20，最大 50）' },
            search_wiki: { type: 'boolean', description: '是否同时搜索 Wiki（默认 true）' },
            doc_types: {
              type: 'string',
              description: '筛选文档类型，逗号分隔（可选：doc, docx, sheet, bitable, mindnote, wiki, slide）',
            },
          },
          required: ['query'],
        },
        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);

          // Parse doc_types from comma-separated string if needed
          let docTypes: string[] | undefined;
          if (typeof args.doc_types === 'string' && args.doc_types) {
            docTypes = (args.doc_types as string).split(',').map(s => s.trim()).filter(Boolean);
          } else if (Array.isArray(args.doc_types)) {
            docTypes = args.doc_types as string[];
          }

          try {
            const res = await fetch(`${this.opts.apiUrl}/api/internal/feishu/search`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.opts.apiToken}`,
              },
              body: JSON.stringify({
                userId: ctx.userId,
                query: args.query,
                count: (args.count as number) || 20,
                searchWiki: args.search_wiki !== false,
                docTypes,
              }),
              signal: controller.signal,
            });
            clearTimeout(timer);

            if (!res.ok) {
              const errBody = await res.json().catch(() => ({})) as { error?: string; code?: string };
              if (errBody.code === 'OAUTH_REQUIRED') {
                return { content: '需要先完成飞书 OAuth 授权才能搜索文档。请让用户在 Web 设置页面中完成「飞书文档授权」（需包含搜索权限）。', isError: true };
              }
              return { content: errBody.error || '搜索飞书文档失败', isError: true };
            }

            const data = await res.json() as {
              results?: Array<{ title?: string; url?: string; docType?: string; owner?: string; preview?: string; updateTime?: string }>;
              hasMore?: boolean;
              total?: number;
            };

            const results = data.results || [];
            if (results.length === 0) {
              return { content: `没有找到与「${args.query}」相关的飞书文档。` };
            }

            const formatted = results
              .map((r, i) => {
                const parts = [`${i + 1}. **${r.title || '无标题'}**`];
                if (r.docType) parts.push(`   类型: ${r.docType}`);
                if (r.owner) parts.push(`   拥有者: ${r.owner}`);
                if (r.url) parts.push(`   链接: ${r.url}`);
                if (r.preview) parts.push(`   预览: ${r.preview}`);
                if (r.updateTime) parts.push(`   更新: ${r.updateTime}`);
                return parts.join('\n');
              })
              .join('\n\n');

            return { content: `找到 ${data.total || results.length} 个结果${data.hasMore ? '（还有更多）' : ''}：\n\n${formatted}` };
          } catch (err) {
            clearTimeout(timer);
            return {
              content: err instanceof Error && err.name === 'AbortError' ? '搜索飞书文档超时' : '无法连接到飞书搜索服务',
              isError: true,
            };
          }
        },
      },
    ];
  }

  getSystemPromptSection(_ctx: PluginContext): string {
    return '';
  }
}
