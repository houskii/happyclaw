/**
 * ContextManager — central orchestrator for plugins, tools, and system prompt assembly.
 *
 * Both Claude and OpenAI runners construct a ContextManager, register plugins,
 * then use it to get tools (adapted to provider format) and build the system prompt.
 */

import type { ContainerInput } from './types.js';
import type { ContextPlugin, PluginContext, ToolDefinition, ToolResult } from './plugin.js';
import { buildBaseSystemPrompt } from './prompt-builder.js';

export class ContextManager {
  private plugins: ContextPlugin[] = [];
  private toolMap = new Map<string, ToolDefinition>();
  private readonly ctx: PluginContext;

  constructor(ctx: PluginContext) {
    this.ctx = ctx;
  }

  /** Register a plugin. Order matters for system prompt assembly. Returns this for chaining. */
  register(plugin: ContextPlugin): this {
    this.plugins.push(plugin);
    // Rebuild tool map
    if (plugin.isEnabled(this.ctx)) {
      for (const tool of plugin.getTools(this.ctx)) {
        this.toolMap.set(tool.name, tool);
      }
    }
    return this;
  }

  /** Get all active tool definitions across all enabled plugins. */
  getActiveTools(): ToolDefinition[] {
    return Array.from(this.toolMap.values());
  }

  /** Route a tool call to the correct plugin's execute(). */
  async executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.toolMap.get(name);
    if (!tool) {
      return { content: `Unknown tool: ${name}`, isError: true };
    }
    return tool.execute(args);
  }

  /** Build the full system prompt from base sections + plugin contributions. */
  buildSystemPrompt(input: ContainerInput, providerInfo?: string): string {
    const parts: string[] = [];

    // Base prompt (environment, workspace instructions, global instructions)
    parts.push(buildBaseSystemPrompt(input, this.ctx, providerInfo));

    // Plugin sections
    for (const plugin of this.plugins) {
      if (!plugin.isEnabled(this.ctx)) continue;
      const section = plugin.getSystemPromptSection(this.ctx);
      if (section) parts.push(section);
    }

    return parts.filter(Boolean).join('\n\n');
  }

  /** Get the plugin context (read-only). */
  getContext(): Readonly<PluginContext> {
    return this.ctx;
  }

  /** Get a specific plugin by name. */
  getPlugin<T extends ContextPlugin>(name: string): T | undefined {
    return this.plugins.find((p) => p.name === name) as T | undefined;
  }
}
