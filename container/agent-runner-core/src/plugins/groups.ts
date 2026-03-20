/**
 * GroupsPlugin — register_group tool (admin home only).
 */

import path from 'path';
import type { ContextPlugin, PluginContext, ToolDefinition, ToolResult } from '../plugin.js';
import { writeIpcFile } from '../ipc.js';

export class GroupsPlugin implements ContextPlugin {
  readonly name = 'groups';

  isEnabled(ctx: PluginContext): boolean {
    return ctx.isAdminHome;
  }

  getTools(ctx: PluginContext): ToolDefinition[] {
    const TASKS_DIR = path.join(ctx.workspaceIpc, 'tasks');

    return [
      {
        name: 'register_group',
        description:
          `Register a new group so the agent can respond to messages there. Admin home only.
Use available_groups.json to find the JID for a group. The folder name should be lowercase with hyphens (e.g., "family-chat").`,
        parameters: {
          type: 'object' as const,
          properties: {
            jid: { type: 'string', description: 'The chat JID (e.g., "feishu:oc_xxxx")' },
            name: { type: 'string', description: 'Display name for the group' },
            folder: { type: 'string', description: 'Folder name for group files (lowercase, hyphens)' },
          },
          required: ['jid', 'name', 'folder'],
        },
        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
          if (!ctx.isAdminHome) {
            return { content: 'Only the admin home container can register new groups.', isError: true };
          }
          writeIpcFile(TASKS_DIR, {
            type: 'register_group',
            jid: args.jid,
            name: args.name,
            folder: args.folder,
            timestamp: new Date().toISOString(),
          });
          return { content: `Group "${args.name}" registered. It will start receiving messages immediately.` };
        },
      },
    ];
  }

  getSystemPromptSection(_ctx: PluginContext): string {
    return '';
  }
}
