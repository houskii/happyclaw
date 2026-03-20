/**
 * Local tools for the OpenAI runner — file operations and command execution.
 *
 * These tools are NOT in agent-runner-core because the Claude SDK has built-in
 * equivalents (Bash, Read, Write, Grep, Glob). Only the OpenAI runner needs
 * hand-rolled versions.
 *
 * Implements ContextPlugin so it plugs into the same ContextManager.
 */

import fs from 'fs';
import path from 'path';
import type {
  ContextPlugin,
  PluginContext,
  ToolDefinition,
  ToolResult,
} from 'happyclaw-agent-runner-core';

export class LocalToolsPlugin implements ContextPlugin {
  readonly name = 'local-tools';

  isEnabled(_ctx: PluginContext): boolean {
    return true;
  }

  getTools(ctx: PluginContext): ToolDefinition[] {
    return [
      // --- execute_command ---
      {
        name: 'execute_command',
        description: 'Execute a shell command and return its output. Use for file operations, git, build tools, etc.',
        parameters: {
          type: 'object' as const,
          properties: {
            command: { type: 'string', description: 'The shell command to execute' },
            timeout: { type: 'number', description: 'Timeout in milliseconds (default 120000)' },
          },
          required: ['command'],
        },
        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
          const { execSync } = await import('child_process');
          const timeout = typeof args.timeout === 'number' ? args.timeout : 120000;
          try {
            const result = execSync(String(args.command), {
              cwd: ctx.workspaceGroup,
              timeout,
              maxBuffer: 1024 * 1024,
              encoding: 'utf-8',
              stdio: ['pipe', 'pipe', 'pipe'],
            });
            return { content: result || '(command completed with no output)' };
          } catch (err: unknown) {
            const execErr = err as { stdout?: string; stderr?: string; status?: number; message?: string };
            const output = [execErr.stdout, execErr.stderr].filter(Boolean).join('\n');
            return { content: output || execErr.message || 'Command failed', isError: true };
          }
        },
      },

      // --- read_file ---
      {
        name: 'read_file',
        description: 'Read a file from the filesystem. Returns the file content with line numbers.',
        parameters: {
          type: 'object' as const,
          properties: {
            file_path: { type: 'string', description: 'Absolute or relative path to the file' },
            offset: { type: 'number', description: 'Line number to start reading from (1-based)' },
            limit: { type: 'number', description: 'Number of lines to read' },
          },
          required: ['file_path'],
        },
        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
          const filePath = String(args.file_path);
          const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(ctx.workspaceGroup, filePath);
          try {
            const content = fs.readFileSync(absPath, 'utf-8');
            const lines = content.split('\n');
            const offset = typeof args.offset === 'number' ? Math.max(0, args.offset - 1) : 0;
            const limit = typeof args.limit === 'number' ? args.limit : lines.length;
            const slice = lines.slice(offset, offset + limit);
            return { content: slice.map((line, i) => `${offset + i + 1}\t${line}`).join('\n') };
          } catch (err: unknown) {
            return { content: `Error reading file: ${err instanceof Error ? err.message : String(err)}`, isError: true };
          }
        },
      },

      // --- write_file ---
      {
        name: 'write_file',
        description: 'Write content to a file, creating it if it does not exist.',
        parameters: {
          type: 'object' as const,
          properties: {
            file_path: { type: 'string', description: 'Path to write to' },
            content: { type: 'string', description: 'Content to write' },
          },
          required: ['file_path', 'content'],
        },
        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
          const filePath = String(args.file_path);
          const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(ctx.workspaceGroup, filePath);
          try {
            fs.mkdirSync(path.dirname(absPath), { recursive: true });
            fs.writeFileSync(absPath, String(args.content));
            return { content: `File written: ${filePath}` };
          } catch (err: unknown) {
            return { content: `Error writing file: ${err instanceof Error ? err.message : String(err)}`, isError: true };
          }
        },
      },

      // --- search_files ---
      {
        name: 'search_files',
        description: 'Search for text patterns in files using ripgrep-style regex.',
        parameters: {
          type: 'object' as const,
          properties: {
            pattern: { type: 'string', description: 'Regex pattern to search for' },
            path: { type: 'string', description: 'Directory or file to search in' },
            glob: { type: 'string', description: 'Glob pattern to filter files (e.g. "*.ts")' },
          },
          required: ['pattern'],
        },
        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
          const { execSync } = await import('child_process');
          const searchPath = typeof args.path === 'string' ? args.path : ctx.workspaceGroup;
          const absPath = path.isAbsolute(searchPath) ? searchPath : path.resolve(ctx.workspaceGroup, searchPath);
          let cmd = `rg --no-heading -n "${String(args.pattern).replace(/"/g, '\\"')}"`;
          if (args.glob) cmd += ` --glob "${String(args.glob).replace(/"/g, '\\"')}"`;
          cmd += ` "${absPath}"`;
          try {
            const result = execSync(cmd, { encoding: 'utf-8', timeout: 30000, maxBuffer: 512 * 1024 });
            const lines = result.split('\n');
            return { content: lines.length > 100 ? lines.slice(0, 100).join('\n') + `\n... (${lines.length} total matches)` : result };
          } catch {
            return { content: 'No matches found.' };
          }
        },
      },

      // --- list_files ---
      {
        name: 'list_files',
        description: 'List files matching a glob pattern.',
        parameters: {
          type: 'object' as const,
          properties: {
            pattern: { type: 'string', description: 'Glob pattern (e.g. "src/**/*.ts")' },
            path: { type: 'string', description: 'Base directory to search in' },
          },
          required: ['pattern'],
        },
        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
          const { execSync } = await import('child_process');
          const basePath = typeof args.path === 'string' ? args.path : ctx.workspaceGroup;
          const absPath = path.isAbsolute(basePath) ? basePath : path.resolve(ctx.workspaceGroup, basePath);
          try {
            const result = execSync(
              `find "${absPath}" -name "${String(args.pattern).replace(/"/g, '\\"')}" -type f 2>/dev/null | head -200`,
              { encoding: 'utf-8', timeout: 15000 },
            );
            return { content: result || 'No files found.' };
          } catch {
            return { content: 'No files found.' };
          }
        },
      },
    ];
  }

  getSystemPromptSection(_ctx: PluginContext): string {
    return [
      '## Tools',
      '',
      'You have tools for: sending messages (send_message, send_image, send_file),',
      'file operations (read_file, write_file, search_files, list_files),',
      'command execution (execute_command), and memory (memory_query, memory_remember).',
    ].join('\n');
  }
}
