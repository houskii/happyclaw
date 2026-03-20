/**
 * Tool format adapters — convert ToolDefinition to provider-specific formats.
 *
 * Each adapter takes the generic ToolDefinition[] from ContextManager
 * and converts to the format required by a specific LLM provider.
 */

import type { ToolDefinition } from './plugin.js';

// ─── OpenAI Chat Completions Format ─────────────────────────

export interface OpenAIFunctionTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** Convert to OpenAI Chat Completions tool format. */
export function toOpenAITools(tools: ToolDefinition[]): OpenAIFunctionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

// ─── Codex Responses API Format ─────────────────────────────

export interface CodexToolDef {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Convert to Codex Responses API tool format. */
export function toCodexTools(tools: ToolDefinition[]): CodexToolDef[] {
  return tools.map((t) => ({
    type: 'function' as const,
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

