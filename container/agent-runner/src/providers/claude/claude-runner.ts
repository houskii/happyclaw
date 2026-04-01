/**
 * ClaudeRunner — implements AgentRunner interface for the Claude provider.
 *
 * Currently delegates to the existing runQuery()/processMessages() functions.
 * This establishes the AgentRunner contract while preserving existing behavior.
 */

import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { createSdkMcpServer, PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { ContextManager } from 'happyclaw-agent-runner-core';
import { buildChannelRoutingReminder, normalizeHomeFlags } from 'happyclaw-agent-runner-core';

import type {
  AgentRunner,
  IpcCapabilities,
  QueryConfig,
  QueryResult,
  NormalizedMessage,
  ActivityReport,
} from '../../runner-interface.js';
import type { ContainerInput, ContainerOutput } from '../../types.js';
import { StreamEventProcessor } from './claude-stream-processor.js';
import { ClaudeSession, type ClaudeSessionConfig } from './claude-session.js';
import { createContextManager, coreToolsToSdkTools } from './claude-mcp-adapter.js';
import { DEFAULT_ALLOWED_TOOLS } from './claude-config.js';
import type { SessionState } from '../../session-state.js';
import type { IpcPaths } from '../../ipc-handler.js';
import {
  IPC_POLL_MS,
  shouldClose,
  shouldDrain,
  shouldInterrupt,
  drainIpcInput,
} from '../../ipc-handler.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ClaudeRunnerOptions {
  containerInput: ContainerInput;
  state: SessionState;
  ipcPaths: IpcPaths;
  log: (msg: string) => void;
  writeOutput: (output: ContainerOutput) => void;
  imChannelsFile: string;
  groupDir: string;
  globalDir: string;
  memoryDir: string;
  model: string;
  thinkingEffort?: string;
  loadUserMcpServers: () => Record<string, unknown>;
  skillsDir: string;
}

// ---------------------------------------------------------------------------
// Error detection helpers
// ---------------------------------------------------------------------------

function isContextOverflowError(msg: string): boolean {
  return [
    /prompt is too long/i,
    /maximum context length/i,
    /context.*too large/i,
    /exceeds.*token limit/i,
    /context window.*exceeded/i,
  ].some(p => p.test(msg));
}

function isImageMimeMismatchError(msg: string): boolean {
  return (
    /image\s+was\s+specified\s+using\s+the\s+image\/[a-z0-9.+-]+\s+media\s+type,\s+but\s+the\s+image\s+appears\s+to\s+be\s+(?:an?\s+)?image\/[a-z0-9.+-]+\s+image/i.test(msg) ||
    /image\/[a-z0-9.+-]+\s+media\s+type.*appears\s+to\s+be.*image\/[a-z0-9.+-]+/i.test(msg)
  );
}

function isUnrecoverableTranscriptError(msg: string): boolean {
  const isImageSizeError =
    /image.*dimensions?\s+exceed/i.test(msg) ||
    /max\s+allowed\s+size.*pixels/i.test(msg);
  const isMimeMismatch = isImageMimeMismatchError(msg);
  const isApiReject = /invalid_request_error/i.test(msg);
  return isApiReject && (isImageSizeError || isMimeMismatch);
}

// ---------------------------------------------------------------------------
// ClaudeRunner
// ---------------------------------------------------------------------------

export class ClaudeRunner implements AgentRunner {
  readonly ipcCapabilities: IpcCapabilities = {
    supportsMidQueryPush: true,
    supportsRuntimeModeSwitch: true,
  };

  private session!: ClaudeSession;
  private processor: StreamEventProcessor | null = null;
  private ctxMgr!: ContextManager;
  private mcpServerConfigBuilder!: () => McpServerConfig;
  private mcpServerConfig!: McpServerConfig;
  private readonly opts: ClaudeRunnerOptions;
  private toolCallStartedAt: number | null = null;

  constructor(opts: ClaudeRunnerOptions) {
    this.opts = opts;
  }

  async initialize(): Promise<void> {
    const { containerInput, groupDir, globalDir, memoryDir } = this.opts;
    const { isHome, isAdminHome } = normalizeHomeFlags(containerInput);

    // Build skills directories list (project-level + user-level)
    const projectSkillsDir = process.env.HAPPYCLAW_PROJECT_SKILLS_DIR || '/workspace/project-skills';
    const userSkillsDir = this.opts.skillsDir;
    const skillsDirs = [projectSkillsDir, userSkillsDir].filter(Boolean);

    // Create ContextManager with all plugins
    const pluginCtx = {
      chatJid: containerInput.chatJid,
      groupFolder: containerInput.groupFolder,
      isHome,
      isAdminHome,
      workspaceIpc: this.opts.ipcPaths.inputDir.replace('/input', ''),
      workspaceGroup: groupDir,
      workspaceGlobal: globalDir,
      workspaceMemory: memoryDir,
      userId: containerInput.userId,
      skillsDirs,
    };
    this.ctxMgr = createContextManager(pluginCtx);

    // Build MCP server config
    this.mcpServerConfigBuilder = () => createSdkMcpServer({
      name: 'happyclaw',
      version: '1.0.0',
      tools: coreToolsToSdkTools(this.ctxMgr),
    });
    this.mcpServerConfig = this.mcpServerConfigBuilder();

    // Initialize ClaudeSession
    this.session = new ClaudeSession(this.opts.log);
  }

  async *runQuery(config: QueryConfig): AsyncGenerator<NormalizedMessage, QueryResult> {
    const { opts } = this;
    const { state, log } = opts;
    const { isHome, isAdminHome } = normalizeHomeFlags(opts.containerInput);

    // Track IM channels from prompt
    state.extractSourceChannels(config.prompt, opts.imChannelsFile);

    // Update dynamic context and build system prompt
    this.ctxMgr.updateDynamicContext({
      recentImChannels: state.recentImChannels,
      contextSummary: opts.containerInput.contextSummary,
    });
    const systemPromptAppend = this.ctxMgr.buildAppendPrompt();

    // Create StreamEventProcessor
    const emit = (output: ContainerOutput): void => {
      // We'll yield stream events instead of directly writing
    };
    this.processor = new StreamEventProcessor(emit, log, (newMode) => {
      state.currentPermissionMode = newMode;
      log(`Auto mode switch on ${newMode === 'plan' ? 'EnterPlanMode' : 'ExitPlanMode'} detection`);
      this.session.setPermissionMode(newMode as PermissionMode).catch((err: unknown) =>
        log(`setPermissionMode failed: ${err}`),
      );
    });

    // Assemble session config
    const extraDirs = [opts.globalDir, opts.memoryDir];
    const sessionConfig: ClaudeSessionConfig = {
      sessionId: config.sessionId,
      resumeAt: config.resumeAt,
      cwd: opts.groupDir,
      additionalDirectories: extraDirs,
      model: opts.model,
      thinkingEffort: opts.thinkingEffort,
      permissionMode: (config.permissionMode ?? state.currentPermissionMode) as PermissionMode,
      allowedTools: DEFAULT_ALLOWED_TOOLS,
      disallowedTools: undefined,
      systemPromptAppend,
      isHostMode: process.env.HAPPYCLAW_HOST_MODE === '1',
      isHome,
      isAdminHome,
      groupFolder: opts.containerInput.groupFolder,
      userId: opts.containerInput.userId,
    };
    const mcpServers: Record<string, McpServerConfig> = {
      ...opts.loadUserMcpServers() as Record<string, McpServerConfig>,
      happyclaw: this.mcpServerConfig,
    };

    // Start session
    const messageGen = this.session.run(sessionConfig, mcpServers);

    // Push initial prompt
    const rejected = this.session.pushMessage(config.prompt, config.images);
    for (const reason of rejected) {
      yield { kind: 'stream_event', event: { eventType: 'status', statusText: `⚠️ ${reason}` } };
    }

    // Re-create processor with emit function that yields stream events
    // We need a way to collect stream events. Use a queue pattern.
    const streamEventQueue: NormalizedMessage[] = [];
    const queueEmit = (output: ContainerOutput): void => {
      if (output.streamEvent) {
        streamEventQueue.push({ kind: 'stream_event', event: output.streamEvent });
      }
      if (output.status === 'success' && output.result !== null) {
        // Will be handled via result message below
      }
    };
    this.processor = new StreamEventProcessor(queueEmit, log, (newMode) => {
      state.currentPermissionMode = newMode;
      this.session.setPermissionMode(newMode as PermissionMode).catch((err: unknown) =>
        log(`setPermissionMode failed: ${err}`),
      );
    });

    // Consume SDK message stream
    let newSessionId: string | undefined;
    let lastResumeUuid: string | undefined;
    let messageCount = 0;
    let toolCallStartedAt: number | null = null;

    try {
      for await (const message of messageGen) {
        // Track tool call timing
        if (this.processor.hasActiveToolCall && toolCallStartedAt === null) {
          toolCallStartedAt = Date.now();
        } else if (!this.processor.hasActiveToolCall) {
          toolCallStartedAt = null;
        }

        // Stream events (highest frequency)
        if (message.type === 'stream_event') {
          this.processor.processStreamEvent(message as any);
          // Flush queued events
          while (streamEventQueue.length > 0) yield streamEventQueue.shift()!;
          continue;
        }
        if (message.type === 'tool_progress') {
          this.processor.processToolProgress(message as any);
          while (streamEventQueue.length > 0) yield streamEventQueue.shift()!;
          continue;
        }
        if (message.type === 'tool_use_summary') {
          this.processor.processToolUseSummary(message as any);
          while (streamEventQueue.length > 0) yield streamEventQueue.shift()!;
          continue;
        }

        // System messages
        if (message.type === 'system') {
          if (this.processor.processSystemMessage(message as any)) {
            while (streamEventQueue.length > 0) yield streamEventQueue.shift()!;
            continue;
          }
          if (message.subtype === 'init') {
            newSessionId = message.session_id as string;
            yield { kind: 'session_init', sessionId: newSessionId! };
          }
          if ((message as any).subtype === 'compact_boundary') {
            const channels = [...state.recentImChannels];
            log(channels.length > 0
              ? `Context compacted, injecting routing reminder for channels: ${channels.join(', ')}`
              : 'Context compacted, no IM channels tracked');
            this.session.pushMessage(buildChannelRoutingReminder(channels));
          }
          if ((message as any).subtype === 'task_notification') {
            this.processor.processTaskNotification(message as any);
            while (streamEventQueue.length > 0) yield streamEventQueue.shift()!;
          }
        }

        messageCount++;

        // Extract background task SDK IDs
        if (message.type === 'user' && !(message as any).parent_tool_use_id) {
          const userContent = (message as any).message?.content;
          if (Array.isArray(userContent)) {
            for (const block of userContent) {
              if (block.type === 'tool_result' && block.tool_use_id && Array.isArray(block.content)) {
                const text = block.content.map((b: { text?: string }) => b.text || '').join('');
                const agentIdMatch = text.match(/agentId:\s*([a-f0-9]+)/);
                if (agentIdMatch && this.processor.isBackgroundTask(block.tool_use_id)) {
                  this.processor.registerSdkTaskId(agentIdMatch[1], block.tool_use_id);
                }
              }
            }
          }
        }

        // Sub-agent messages
        this.processor.processSubAgentMessage(message as any);
        while (streamEventQueue.length > 0) yield streamEventQueue.shift()!;

        // Assistant messages → resume anchor
        if (message.type === 'assistant' && 'uuid' in message) {
          const content = (message as any).message?.content;
          const hasText = Array.isArray(content)
            ? content.some((b: { type: string }) => b.type === 'text')
            : typeof content === 'string';
          if (hasText) {
            lastResumeUuid = (message as any).uuid as string;
            yield { kind: 'resume_anchor', anchor: lastResumeUuid! };
          }
          this.processor.processAssistantMessage(message as any);
          while (streamEventQueue.length > 0) yield streamEventQueue.shift()!;
        }

        // User(tool_result) → resume anchor
        if (message.type === 'user' && 'uuid' in message) {
          const content = (message as any).message?.content;
          const hasToolResult = Array.isArray(content)
            && content.some((b: { type: string }) => b.type === 'tool_result');
          if (hasToolResult) {
            lastResumeUuid = (message as any).uuid as string;
            yield { kind: 'resume_anchor', anchor: lastResumeUuid! };
          }
        }

        // Result
        if (message.type === 'result') {
          const textResult = (message as any).result as string | null;
          const resultSubtype = (message as any).subtype as string | undefined;

          // Error results
          if (typeof resultSubtype === 'string' && (resultSubtype === 'error_during_execution' || resultSubtype.startsWith('error'))) {
            this.session.end();
            if (!newSessionId) {
              yield {
                kind: 'error',
                message: `Session resume failed: ${resultSubtype}`,
                recoverable: false,
                errorType: 'session_resume_failed',
              };
              this.processor.cleanup();
              return {
                newSessionId,
                resumeAnchor: lastResumeUuid,
                closedDuringQuery: false,
                interruptedDuringQuery: false,
                drainDetectedDuringQuery: false,
                sessionResumeFailed: true,
              };
            }
            const detail = textResult?.trim() || `Claude Code execution failed (${resultSubtype})`;
            // Check for specific error types
            if (isContextOverflowError(detail)) {
              this.processor.resetFullTextAccumulator();
              yield { kind: 'error', message: detail, recoverable: true, errorType: 'context_overflow' };
              this.processor.cleanup();
              return {
                newSessionId, resumeAnchor: lastResumeUuid,
                closedDuringQuery: false, interruptedDuringQuery: false,
                drainDetectedDuringQuery: false, contextOverflow: true,
              };
            }
            if (isUnrecoverableTranscriptError(detail)) {
              this.processor.resetFullTextAccumulator();
              yield { kind: 'error', message: detail, recoverable: false, errorType: 'unrecoverable_transcript' };
              this.processor.cleanup();
              return {
                newSessionId, resumeAnchor: lastResumeUuid,
                closedDuringQuery: false, interruptedDuringQuery: false,
                drainDetectedDuringQuery: false, unrecoverableTranscriptError: true,
              };
            }
            throw new Error(detail);
          }

          // Check for overflow in successful results
          if (textResult && isContextOverflowError(textResult)) {
            this.session.end();
            this.processor.resetFullTextAccumulator();
            yield { kind: 'error', message: textResult, recoverable: true, errorType: 'context_overflow' };
            this.processor.cleanup();
            return {
              newSessionId, resumeAnchor: lastResumeUuid,
              closedDuringQuery: false, interruptedDuringQuery: false,
              drainDetectedDuringQuery: false, contextOverflow: true,
            };
          }
          if (textResult && isUnrecoverableTranscriptError(textResult)) {
            this.session.end();
            this.processor.resetFullTextAccumulator();
            yield { kind: 'error', message: textResult, recoverable: false, errorType: 'unrecoverable_transcript' };
            this.processor.cleanup();
            return {
              newSessionId, resumeAnchor: lastResumeUuid,
              closedDuringQuery: false, interruptedDuringQuery: false,
              drainDetectedDuringQuery: false, unrecoverableTranscriptError: true,
            };
          }

          // Successful result
          const { effectiveResult } = this.processor.processResult(textResult);
          while (streamEventQueue.length > 0) yield streamEventQueue.shift()!;

          // Extract usage
          const resultMsg = message as Record<string, unknown>;
          const sdkUsage = resultMsg.usage as Record<string, number> | undefined;
          const sdkModelUsage = resultMsg.modelUsage as Record<string, Record<string, number>> | undefined;
          let usageInfo = undefined;
          if (sdkUsage) {
            const modelUsageSummary: Record<string, { inputTokens: number; outputTokens: number; costUSD: number }> = {};
            if (sdkModelUsage && Object.keys(sdkModelUsage).length > 0) {
              for (const [mdl, mu] of Object.entries(sdkModelUsage)) {
                modelUsageSummary[mdl] = {
                  inputTokens: mu.inputTokens || 0,
                  outputTokens: mu.outputTokens || 0,
                  costUSD: mu.costUSD || 0,
                };
              }
            } else {
              modelUsageSummary[opts.model] = {
                inputTokens: sdkUsage.input_tokens || 0,
                outputTokens: sdkUsage.output_tokens || 0,
                costUSD: (resultMsg.total_cost_usd as number) || 0,
              };
            }
            usageInfo = {
              inputTokens: sdkUsage.input_tokens || 0,
              outputTokens: sdkUsage.output_tokens || 0,
              cacheReadInputTokens: sdkUsage.cache_read_input_tokens || 0,
              cacheCreationInputTokens: sdkUsage.cache_creation_input_tokens || 0,
              costUSD: (resultMsg.total_cost_usd as number) || 0,
              durationMs: (resultMsg.duration_ms as number) || 0,
              numTurns: (resultMsg.num_turns as number) || 0,
              modelUsage: Object.keys(modelUsageSummary).length > 0 ? modelUsageSummary : undefined,
            };
          }

          yield { kind: 'result', text: effectiveResult, usage: usageInfo };

          // Check background tasks
          if (this.processor.pendingBackgroundTaskCount > 0) {
            log(`Result received but ${this.processor.pendingBackgroundTaskCount} background task(s) pending`);
            continue;
          }
          this.session.end();
          break;
        }
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (isContextOverflowError(errorMessage)) {
        yield { kind: 'error', message: errorMessage, recoverable: true, errorType: 'context_overflow' };
        this.processor?.cleanup();
        return {
          newSessionId, resumeAnchor: lastResumeUuid,
          closedDuringQuery: false, interruptedDuringQuery: false,
          drainDetectedDuringQuery: false, contextOverflow: true,
        };
      }
      if (isUnrecoverableTranscriptError(errorMessage)) {
        yield { kind: 'error', message: errorMessage, recoverable: false, errorType: 'unrecoverable_transcript' };
        this.processor?.cleanup();
        return {
          newSessionId, resumeAnchor: lastResumeUuid,
          closedDuringQuery: false, interruptedDuringQuery: false,
          drainDetectedDuringQuery: false, unrecoverableTranscriptError: true,
        };
      }
      throw err;
    }

    this.processor.cleanup();

    return {
      newSessionId,
      resumeAnchor: lastResumeUuid,
      closedDuringQuery: false,
      interruptedDuringQuery: false,
      drainDetectedDuringQuery: false,
    };
  }

  pushMessage(text: string, images?: Array<{ data: string; mimeType?: string }>): string[] {
    return this.session.pushMessage(text, images);
  }

  async interrupt(): Promise<void> {
    await this.session.interrupt();
    this.session.end();
  }

  async setPermissionMode(mode: string): Promise<void> {
    await this.session.setPermissionMode(mode as PermissionMode);
  }

  getActivityReport(): ActivityReport {
    const hasActive = this.processor?.hasActiveToolCall ?? false;
    return {
      hasActiveToolCall: hasActive,
      activeToolDurationMs: hasActive && this.toolCallStartedAt
        ? Date.now() - this.toolCallStartedAt
        : 0,
      hasPendingBackgroundTasks: (this.processor?.pendingBackgroundTaskCount ?? 0) > 0,
    };
  }

  async betweenQueries(): Promise<void> {
    this.mcpServerConfig = this.mcpServerConfigBuilder();
  }

  async cleanup(): Promise<void> {
    // No special cleanup needed for Claude provider
  }

  /** Expose the ContextManager for external use (e.g., index.ts MCP server setup). */
  getContextManager(): ContextManager {
    return this.ctxMgr;
  }

  /** Expose the MCP server config builder. */
  getMcpServerConfig(): McpServerConfig {
    return this.mcpServerConfig;
  }
}

export { createContextManager, coreToolsToSdkTools };
