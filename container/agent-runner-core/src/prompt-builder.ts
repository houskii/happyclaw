/**
 * System prompt builder — assembles base prompt sections shared by all runners.
 */

import fs from 'fs';
import path from 'path';
import type { ContainerInput } from './types.js';
import type { PluginContext } from './plugin.js';

/** Build the base system prompt (environment, workspace/global instructions). */
export function buildBaseSystemPrompt(
  input: ContainerInput,
  ctx: PluginContext,
  providerInfo?: string,
): string {
  const parts: string[] = [];

  parts.push(
    `You are an AI assistant running in the HappyClaw platform${providerInfo ? `, powered by ${providerInfo}` : ''}.`,
    '',
    '## Environment',
    `- Working directory: ${ctx.workspaceGroup}`,
    `- Group folder: ${input.groupFolder}`,
    '',
  );

  // Load workspace CLAUDE.md
  const workspaceInstructions = tryReadFile(path.join(ctx.workspaceGroup, 'CLAUDE.md'));
  if (workspaceInstructions) {
    parts.push('## Workspace Instructions', '', workspaceInstructions, '');
  }

  // Load global CLAUDE.md
  const globalInstructions = tryReadFile(path.join(ctx.workspaceGlobal, 'CLAUDE.md'));
  if (globalInstructions) {
    parts.push('## Global Instructions', '', globalInstructions, '');
  }

  // Communication rules
  parts.push(
    '## Communication Rules',
    '',
    'Your text output (stdout) only appears in the Web UI.',
    'To send messages to IM channels (Feishu/Telegram/QQ), use the send_message tool with the channel parameter.',
    'The channel value comes from the message\'s source attribute (e.g. "feishu:oc_xxx", "telegram:123").',
    '',
  );

  // Output guidelines
  parts.push(
    '## Output Guidelines',
    '',
    '- When generating image files for display, use Markdown image syntax with relative paths: `![description](filename.png)`',
    '- For technical diagrams, use Mermaid syntax in ```mermaid code blocks.',
    '- Prefer WebFetch for external web access. If it fails, use agent-browser if available.',
    '- For long-running tasks, acknowledge first, then work, then report results.',
    '',
  );

  return parts.join('\n');
}

function tryReadFile(filePath: string): string | null {
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8');
    }
  } catch { /* ignore */ }
  return null;
}
