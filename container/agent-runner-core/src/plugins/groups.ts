/**
 * GroupsPlugin — register_group tool (admin home only).
 */

import path from 'path';
import { writeIpcFile } from '../ipc.js';
import type {
  ContextPlugin,
  PluginContext,
  ToolDefinition,
} from '../plugin.js';

export class GroupsPlugin implements ContextPlugin {
  readonly name = 'groups';

  isEnabled(ctx: PluginContext): boolean {
    return ctx.isAdminHome;
  }

  getTools(ctx: PluginContext): ToolDefinition[] {
    const tasksDir = path.join(ctx.workspaceIpc, 'tasks');

    return [
      {
        name: 'register_group',
        description: `Register a new group so the agent can respond to messages there. Admin home only.
Use available_groups.json to find the JID for a group. The folder name should be lowercase with hyphens (e.g., "family-chat").`,
        parameters: {
          type: 'object',
          properties: {
            jid: { type: 'string', description: 'The chat JID (e.g., "feishu:oc_xxxx")' },
            name: { type: 'string', description: 'Display name for the group' },
            folder: { type: 'string', description: 'Folder name for group files (lowercase, hyphens)' },
          },
          required: ['jid', 'name', 'folder'],
        },
        execute: async (args: Record<string, unknown>) => {
          if (!ctx.isAdminHome) {
            return {
              content: 'Only the admin home container can register new groups.',
              isError: true,
            };
          }

          const jid = getRequiredStringArg(args, 'jid');
          const name = getRequiredStringArg(args, 'name');
          const folder = getRequiredStringArg(args, 'folder');

          if (!jid || !name || !folder) {
            return {
              content: 'jid, name, and folder are required.',
              isError: true,
            };
          }

          writeIpcFile(tasksDir, {
            type: 'register_group',
            jid,
            name,
            folder,
            timestamp: new Date().toISOString(),
          });

          return {
            content: `Group "${name}" registered. It will start receiving messages immediately.`,
          };
        },
      },
    ];
  }

  getSystemPromptSection(_ctx: PluginContext): string {
    return '';
  }
}

function getRequiredStringArg(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}
