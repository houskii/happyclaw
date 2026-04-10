/**
 * MessagingPlugin — send_message, send_image, send_file tools.
 *
 * All three communicate with the host process via IPC files.
 */

import fs from 'fs';
import path from 'path';
import { writeIpcFile } from '../ipc.js';
import type {
  ContextPlugin,
  PluginContext,
  ToolDefinition,
} from '../plugin.js';

export class MessagingPlugin implements ContextPlugin {
  readonly name = 'messaging';

  isEnabled(_ctx: PluginContext): boolean {
    return true;
  }

  getTools(ctx: PluginContext): ToolDefinition[] {
    const messagesDir = path.join(ctx.workspaceIpc, 'messages');

    return [
      {
        name: 'send_message',
        description:
          "Send a message to an IM channel (Feishu/Telegram/QQ) or Web UI. "
          + "Your stdout only appears in Web UI and is never sent to IM. To reach IM users, you MUST call this tool with the channel parameter (from the message's source attribute, e.g. 'feishu:oc_xxx', 'telegram:123'). "
          + 'IMPORTANT: IM users cannot see your streaming output, tool calls, or thinking process — from their perspective, you are silent until you explicitly send_message. '
          + "When handling a request that takes time (research, coding, file operations, etc.), send a brief acknowledgment FIRST (e.g. '我看看哦', 'let me check'), then do your work, then send the result. Do not make the user wait in silence.",
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The message text to send' },
            channel: {
              type: 'string',
              description:
                "Target IM channel, taken from the message's source attribute (e.g. 'feishu:oc_xxx', 'telegram:123'). Omit to only display in Web UI.",
            },
            urgent: {
              type: 'boolean',
              description: 'Send as urgent/加急 message (Feishu only). Use sparingly — only for time-sensitive interactions.',
            },
            reply_to_message_id: {
              type: 'string',
              description: 'Reply to a specific message by its ID (from the message id attribute).',
            },
          },
          required: ['text'],
        },
        execute: async (args: Record<string, unknown>) => {
          const text = getOptionalStringArg(args, 'text');
          if (!text) {
            return { content: 'Error: text is required.', isError: true };
          }

          writeIpcFile(messagesDir, {
            type: 'message',
            chatJid: ctx.chatJid,
            text,
            targetChannel: getOptionalStringArg(args, 'channel'),
            urgent: typeof args.urgent === 'boolean' ? args.urgent : false,
            replyToMsgId: getOptionalStringArg(args, 'reply_to_message_id'),
            groupFolder: ctx.groupFolder,
            timestamp: new Date().toISOString(),
          });

          return { content: 'Message sent.' };
        },
      },
      {
        name: 'send_image',
        description:
          'Send an image file from the workspace to an IM channel (Feishu/Telegram/QQ). '
          + 'The channel parameter is required. The file must be an image (PNG, JPEG, GIF, WebP, etc.) and must exist in the workspace. Max 10MB.',
        parameters: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'Path to the image file in the workspace (relative to workspace root or absolute)',
            },
            channel: {
              type: 'string',
              description: "Target IM channel (required). Taken from the message's source attribute.",
            },
            caption: {
              type: 'string',
              description: 'Optional caption text to send with the image',
            },
          },
          required: ['file_path', 'channel'],
        },
        execute: async (args: Record<string, unknown>) => {
          const filePath = getOptionalStringArg(args, 'file_path');
          const channel = getOptionalStringArg(args, 'channel');
          const caption = getOptionalStringArg(args, 'caption');

          if (!filePath || !channel) {
            return {
              content: 'Error: file_path and channel are required.',
              isError: true,
            };
          }

          const absolutePath = path.isAbsolute(filePath)
            ? filePath
            : path.join(ctx.workspaceGroup, filePath);
          const resolved = path.resolve(absolutePath);

          if (!isWithinWorkspace(resolved, ctx)) {
            return {
              content: 'Error: file path must be within workspace directory.',
              isError: true,
            };
          }
          if (!fs.existsSync(resolved)) {
            return {
              content: `Error: file not found: ${filePath}`,
              isError: true,
            };
          }

          const stat = fs.statSync(resolved);
          if (stat.size > 10 * 1024 * 1024) {
            return {
              content: `Error: image file too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Maximum is 10MB.`,
              isError: true,
            };
          }
          if (stat.size === 0) {
            return { content: 'Error: image file is empty.', isError: true };
          }

          const buffer = fs.readFileSync(resolved);
          const mimeType = detectImageMime(buffer);
          if (!mimeType) {
            return {
              content: 'Error: file does not appear to be a supported image format (PNG, JPEG, GIF, WebP, TIFF, BMP).',
              isError: true,
            };
          }

          writeIpcFile(messagesDir, {
            type: 'image',
            chatJid: ctx.chatJid,
            targetChannel: channel,
            imageBase64: buffer.toString('base64'),
            mimeType,
            caption: caption || undefined,
            fileName: path.basename(resolved),
            groupFolder: ctx.groupFolder,
            timestamp: new Date().toISOString(),
          });

          return {
            content: `Image sent: ${path.basename(resolved)} (${mimeType}, ${(stat.size / 1024).toFixed(1)}KB)`,
          };
        },
      },
      {
        name: 'send_file',
        description:
          'Send a file to an IM channel (Feishu/Telegram/QQ). '
          + 'The channel parameter is required. Supports PDF, DOC, XLS, PPT, MP4, etc. Max 30MB.',
        parameters: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'File path relative to workspace/group (e.g., "output/report.pdf")',
            },
            fileName: {
              type: 'string',
              description: 'File name to display (e.g., "report.pdf")',
            },
            channel: {
              type: 'string',
              description: "Target IM channel (required). Taken from the message's source attribute.",
            },
          },
          required: ['filePath', 'fileName', 'channel'],
        },
        execute: async (args: Record<string, unknown>) => {
          const filePath = getOptionalStringArg(args, 'filePath');
          const fileName = getOptionalStringArg(args, 'fileName');
          const channel = getOptionalStringArg(args, 'channel');

          if (!filePath || !fileName || !channel) {
            return {
              content: 'Error: filePath, fileName, and channel are required.',
              isError: true,
            };
          }

          let resolvedPath: string;
          let ipcFilePath: string;

          if (path.isAbsolute(filePath)) {
            resolvedPath = path.resolve(filePath);
            if (!isWithinWorkspace(resolvedPath, ctx)) {
              return {
                content: 'Error: absolute path must be within workspace or global directory.',
                isError: true,
              };
            }
            ipcFilePath = resolvedPath;
          } else {
            resolvedPath = path.resolve(ctx.workspaceGroup, filePath);
            const safeRoot = ctx.workspaceGroup.endsWith(path.sep)
              ? ctx.workspaceGroup
              : `${ctx.workspaceGroup}${path.sep}`;
            if (
              resolvedPath !== ctx.workspaceGroup
              && !resolvedPath.startsWith(safeRoot)
            ) {
              return {
                content: 'Error: file must be within the workspace/group directory.',
                isError: true,
              };
            }
            ipcFilePath = filePath;
          }

          if (!fs.existsSync(resolvedPath)) {
            return {
              content: `Error: file not found: ${filePath}`,
              isError: true,
            };
          }

          const stat = fs.statSync(resolvedPath);
          if (stat.size > 30 * 1024 * 1024) {
            return {
              content: `Error: file too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Maximum is 30MB.`,
              isError: true,
            };
          }

          writeIpcFile(path.join(ctx.workspaceIpc, 'tasks'), {
            type: 'send_file',
            chatJid: ctx.chatJid,
            targetChannel: channel,
            filePath: ipcFilePath,
            fileName,
            timestamp: new Date().toISOString(),
          });

          return { content: `Sending file "${fileName}"...` };
        },
      },
    ];
  }

  getSystemPromptSection(_ctx: PluginContext): string {
    return '';
  }
}

function getOptionalStringArg(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isWithinWorkspace(resolved: string, ctx: PluginContext): boolean {
  const groupRoot = ctx.workspaceGroup.endsWith(path.sep)
    ? ctx.workspaceGroup
    : `${ctx.workspaceGroup}${path.sep}`;
  const inGroup = resolved === ctx.workspaceGroup || resolved.startsWith(groupRoot);
  if (inGroup) {
    return true;
  }

  if (ctx.workspaceGlobal) {
    const globalRoot = ctx.workspaceGlobal.endsWith(path.sep)
      ? ctx.workspaceGlobal
      : `${ctx.workspaceGlobal}${path.sep}`;
    if (
      resolved === ctx.workspaceGlobal
      || resolved.startsWith(globalRoot)
    ) {
      return true;
    }
  }

  return false;
}

/** Detect image MIME type from buffer magic bytes. */
function detectImageMime(buffer: Buffer): string | null {
  if (buffer.length < 4) {
    return null;
  }

  if (
    buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
  ) {
    return 'image/png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer[0] === 0x47
    && buffer[1] === 0x49
    && buffer[2] === 0x46
    && buffer[3] === 0x38
  ) {
    return 'image/gif';
  }
  if (
    buffer.length >= 12
    && buffer[0] === 0x52
    && buffer[1] === 0x49
    && buffer[2] === 0x46
    && buffer[3] === 0x46
    && buffer[8] === 0x57
    && buffer[9] === 0x45
    && buffer[10] === 0x42
    && buffer[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (
    (buffer[0] === 0x49
      && buffer[1] === 0x49
      && buffer[2] === 0x2a
      && buffer[3] === 0x00)
    || (buffer[0] === 0x4d
      && buffer[1] === 0x4d
      && buffer[2] === 0x00
      && buffer[3] === 0x2a)
  ) {
    return 'image/tiff';
  }
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return 'image/bmp';
  }

  return null;
}
