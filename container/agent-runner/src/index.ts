/**
 * HappyClaw Agent Runner — Protocol Bridge
 *
 * Entry point and query loop orchestration. Receives ContainerInput via stdin,
 * runs Claude queries in a loop (query → wait for IPC → repeat), and outputs
 * ContainerOutput wrapped in OUTPUT_MARKER pairs to stdout.
 *
 * Module responsibilities (nothing else belongs here):
 * - stdin/stdout protocol (ContainerInput/Output, OUTPUT_MARKER)
 * - Query loop: run → wait IPC → next query → until _close/_drain
 * - Error recovery: context overflow retries, session resume fallback
 * - Signal handlers: SIGTERM/SIGINT/EPIPE/uncaughtException
 * - MCP server lifecycle: rebuild between queries
 *
 * All other logic is in dedicated modules:
 * - session-state.ts: shared mutable state
 * - claude-session.ts: SDK query lifecycle
 * - query-runner.ts: single query execution
 * - context-builder.ts: system prompt assembly
 * - ipc-handler.ts: IPC sentinel/message handling
 * - transcript-archive.ts: PreCompact hook + conversation archival
 * - safety-lite.ts: host-mode safety checks
 * - image-utils.ts: image processing utilities
 */

import fs from 'fs';
import path from 'path';
import { createSdkMcpServer, PermissionMode } from '@anthropic-ai/claude-agent-sdk';

import type {
  ContainerInput,
  ContainerOutput,
} from './types.js';
export type { StreamEventType, StreamEvent } from './types.js';

import { ClaudeSession } from './claude-session.js';
import { createContextManager, coreToolsToSdkTools } from './mcp-adapter.js';
import { SessionState } from './session-state.js';
import { normalizeHomeFlags } from 'happyclaw-agent-runner-core';
import {
  buildIpcPaths,
  shouldDrain,
  drainIpcInput,
  waitForIpcMessage,
  isInterruptRelatedError,
} from './ipc-handler.js';
import { runQuery } from './query-runner.js';

// 路径解析：优先读取环境变量，降级到容器内默认路径（保持向后兼容）
const WORKSPACE_GROUP = process.env.HAPPYCLAW_WORKSPACE_GROUP || '/workspace/group';
const WORKSPACE_GLOBAL = process.env.HAPPYCLAW_WORKSPACE_GLOBAL || '/workspace/global';
const WORKSPACE_MEMORY = process.env.HAPPYCLAW_WORKSPACE_MEMORY || '/workspace/memory';
const WORKSPACE_IPC = process.env.HAPPYCLAW_WORKSPACE_IPC || '/workspace/ipc';
const WORKSPACE_SKILLS = process.env.HAPPYCLAW_SKILLS_DIR || '/workspace/user-skills';

// 模型配置：支持别名（opus/sonnet/haiku）或完整模型 ID
// 别名自动解析为最新版本，如 opus → Opus 4.6
const CLAUDE_MODEL = process.env.HAPPYCLAW_MODEL || process.env.ANTHROPIC_MODEL || 'opus';

const ipcPaths = buildIpcPaths(WORKSPACE_IPC);

// IM channels file path — stays in index.ts because it depends on WORKSPACE_IPC
const IM_CHANNELS_FILE = path.join(WORKSPACE_IPC, '.recent-im-channels.json');

// Session state: replaces scattered module-level variables with explicit state object.
// Module-level because process event handlers (uncaughtException, unhandledRejection)
// need access to interrupt grace window state.
const state = new SessionState();

const DEFAULT_ALLOWED_TOOLS = [
  'Bash',
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch',
  'Task', 'TaskOutput', 'TaskStop',
  'TeamCreate', 'TeamDelete', 'SendMessage',
  'TodoWrite', 'ToolSearch', 'Skill',
  'NotebookEdit',
  'mcp__happyclaw__*'
];

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---HAPPYCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---HAPPYCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

/** 从 settings.json 读取用户配置的 MCP servers（stdio/http/sse 类型） */
function loadUserMcpServers(): Record<string, unknown> {
  const configDir = process.env.CLAUDE_CONFIG_DIR
    || path.join(process.env.HOME || '/home/node', '.claude');
  const settingsFile = path.join(configDir, 'settings.json');
  try {
    if (fs.existsSync(settingsFile)) {
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      if (settings.mcpServers && typeof settings.mcpServers === 'object') {
        return settings.mcpServers;
      }
    }
  } catch { /* ignore parse errors */ }
  return {};
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  let sessionId = containerInput.sessionId;
  const { isHome, isAdminHome } = normalizeHomeFlags(containerInput);

  // Restore persisted IM channels from previous sessions
  state.loadImChannels(IM_CHANNELS_FILE);

  // Create ContextManager with all plugins, then convert to SDK tools
  const pluginCtx = {
    chatJid: containerInput.chatJid,
    groupFolder: containerInput.groupFolder,
    isHome,
    isAdminHome,
    workspaceIpc: WORKSPACE_IPC,
    workspaceGroup: WORKSPACE_GROUP,
    workspaceGlobal: WORKSPACE_GLOBAL,
    workspaceMemory: WORKSPACE_MEMORY,
    userId: containerInput.userId,
  };
  const ctxMgr = createContextManager(pluginCtx);
  const buildMcpServerConfig = () => createSdkMcpServer({
    name: 'happyclaw',
    version: '1.0.0',
    tools: coreToolsToSdkTools(ctxMgr),
  });
  let mcpServerConfig = buildMcpServerConfig();
  fs.mkdirSync(ipcPaths.inputDir, { recursive: true });

  // Clean up stale sentinels from previous container runs
  try { fs.unlinkSync(ipcPaths.closeSentinel); } catch { /* ignore */ }
  try { fs.unlinkSync(ipcPaths.drainSentinel); } catch { /* ignore */ }
  try { fs.unlinkSync(ipcPaths.interruptSentinel); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  let promptImages = containerInput.images;
  const pendingDrain = drainIpcInput(ipcPaths, log);
  if (pendingDrain.modeChange) {
    state.currentPermissionMode = pendingDrain.modeChange as PermissionMode;
    log(`Initial mode change via IPC: ${pendingDrain.modeChange}`);
  }
  if (pendingDrain.messages.length > 0) {
    log(`Draining ${pendingDrain.messages.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pendingDrain.messages.map((m) => m.text).join('\n');
    const pendingImages = pendingDrain.messages.flatMap((m) => m.images || []);
    if (pendingImages.length > 0) {
      promptImages = [...(promptImages || []), ...pendingImages];
    }
  }

  // Query loop: run query -> wait for IPC message -> run new query -> repeat
  const session = new ClaudeSession(log);
  let resumeAt: string | undefined;
  let overflowRetryCount = 0;
  const MAX_OVERFLOW_RETRIES = 3;
  try {
    while (true) {
      // 清理残留的 _interrupt sentinel，防止空闲期间写入的中断信号影响下一次 query
      try { fs.unlinkSync(ipcPaths.interruptSentinel); } catch { /* ignore */ }
      state.clearInterruptRequested();

      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      const queryResult = await runQuery(
        prompt,
        sessionId,
        mcpServerConfig,
        containerInput,
        session,
        state,
        ipcPaths,
        log,
        writeOutput,
        IM_CHANNELS_FILE,
        WORKSPACE_GROUP,
        WORKSPACE_GLOBAL,
        WORKSPACE_MEMORY,
        CLAUDE_MODEL,
        loadUserMcpServers,
        ctxMgr,
        resumeAt,
        true,
        DEFAULT_ALLOWED_TOOLS,
        undefined,
        promptImages,
      );
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      // Advance resumeAt to the latest safe resume point in the session.
      // lastResumeUuid tracks the latest of: assistant(text) or user(tool_result).
      // This ensures the session advances linearly even when the agent's last
      // action is a tool_use without text output (common in IM chat where the
      // agent only calls send_message). Without this, resumeAt sticks at an
      // earlier text message, creating parallel branches where each query loses
      // visibility of prior turns.
      if (queryResult.lastResumeUuid) {
        resumeAt = queryResult.lastResumeUuid;
      } else if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // Rebuild MCP server config between queries to prevent stale transport.
      // The SDK's createSdkMcpServer transport can become disconnected when the
      // internal CLI process exits between query turns. Without rebuilding, the
      // next query may get "Stream closed" errors on MCP tool calls.
      mcpServerConfig = buildMcpServerConfig();

      // Session resume 失败（SDK 无法恢复旧会话）：清除 session，以新会话重试
      if (queryResult.sessionResumeFailed) {
        log(`Session resume failed, retrying with fresh session (old: ${sessionId})`);
        sessionId = undefined;
        resumeAt = undefined;
        continue;
      }

      // 不可恢复的转录错误（如超大图片或 MIME 错配被固化在会话历史中）
      if (queryResult.unrecoverableTranscriptError) {
        const errorMsg = '会话历史中包含无法处理的数据（如超大图片或图片 MIME 错配），会话需要重置。';
        log(`Unrecoverable transcript error, signaling session reset`);
        writeOutput({
          status: 'error',
          result: null,
          error: `unrecoverable_transcript: ${errorMsg}`,
          newSessionId: sessionId,
        });
        process.exit(1);
      }

      // 检查上下文溢出
      if (queryResult.contextOverflow) {
        overflowRetryCount++;
        log(`Context overflow detected, retry ${overflowRetryCount}/${MAX_OVERFLOW_RETRIES}`);

        if (overflowRetryCount >= MAX_OVERFLOW_RETRIES) {
          const errorMsg = `上下文溢出错误：已重试 ${MAX_OVERFLOW_RETRIES} 次仍失败。请联系管理员检查 CLAUDE.md 大小或减少会话历史。`;
          log(errorMsg);
          writeOutput({
            status: 'error',
            result: null,
            error: `context_overflow: ${errorMsg}`,
            newSessionId: sessionId,
          });
          process.exit(1);
        }

        // 未超过重试次数，等待后继续下一轮循环（会触发自动压缩）
        log('Retrying query after context overflow (will trigger auto-compaction)...');
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      // 成功执行后重置溢出重试计数器
      overflowRetryCount = 0;

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        // Notify host that this exit was due to _close, not a normal completion.
        // Without this marker the host treats the exit as silent success and
        // commits the message cursor, causing the in-flight IM message to be
        // consumed without a reply (the "swallowed message" bug).
        writeOutput({ status: 'closed', result: null });
        break;
      }

      // 中断后：跳过 memory flush 和 session update，等待下一条消息
      if (queryResult.interruptedDuringQuery) {
        log('Query interrupted by user, waiting for next message');
        writeOutput({
          status: 'stream',
          result: null,
          streamEvent: { eventType: 'status', statusText: 'interrupted' },
        });
        // 清理可能残留的 _interrupt 文件
        try { fs.unlinkSync(ipcPaths.interruptSentinel); } catch { /* ignore */ }
        // 不 break，等待下一条消息
        const nextMessage = await waitForIpcMessage(ipcPaths, log, writeOutput, state, IM_CHANNELS_FILE);
        if (nextMessage === null) {
          log('Close sentinel received after interrupt, exiting');
          break;
        }
        state.clearInterruptRequested();
        prompt = nextMessage.text;
        promptImages = nextMessage.images;
        continue;
      }

      // Check for _drain sentinel: finish current query then exit for turn boundary.
      // Unlike _close (where the host sends SIGTERM), _drain requires self-exit
      // because the host is waiting for the process to terminate naturally.
      // Check both: the flag set during pollIpcDuringQuery AND the sentinel file
      // (in case it was written after the query's IPC polling stopped).
      if (queryResult.drainDetectedDuringQuery || shouldDrain(ipcPaths)) {
        log('Drain sentinel detected, exiting for turn boundary');
        writeOutput({ status: 'drained', result: null, newSessionId: sessionId });
        process.exit(0);
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close/_drain sentinel
      const nextMessage = await waitForIpcMessage(ipcPaths, log, writeOutput, state, IM_CHANNELS_FILE);
      if (nextMessage === null) {
        log('Close/drain sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.text.length} chars, ${nextMessage.images?.length || 0} images), starting new query`);
      prompt = nextMessage.text;
      promptImages = nextMessage.images;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    if (err instanceof Error && err.stack) {
      log(`Agent error stack:\n${err.stack}`);
    }
    // Log cause chain for SDK-wrapped errors (e.g. EPIPE from internal claude CLI)
    const cause = err instanceof Error ? (err as NodeJS.ErrnoException & { cause?: unknown }).cause : undefined;
    if (cause) {
      const causeMsg = cause instanceof Error ? cause.stack || cause.message : String(cause);
      log(`Agent error cause:\n${causeMsg}`);
    }
    log(`Agent error errno: ${(err as NodeJS.ErrnoException).code ?? 'none'} exitCode: ${process.exitCode ?? 'none'}`);
    // 不在 error output 中携带 sessionId：
    // 流式输出已通过 onOutput 回调传递了有效的 session 更新。
    // 如果这里携带的是 throw 前的旧 sessionId，会覆盖中间成功产生的新 session。
    writeOutput({
      status: 'error',
      result: null,
      error: errorMessage
    });
    process.exit(1);
  }
}

// 处理管道断开（EPIPE）：父进程关闭管道后仍有写入时，静默退出避免 code 1 错误输出
(process.stdout as NodeJS.WriteStream & NodeJS.EventEmitter).on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
});
(process.stderr as NodeJS.WriteStream & NodeJS.EventEmitter).on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
});

/**
 * 某些 SDK/底层 socket 会在管道断开后触发未捕获 EPIPE。
 * 这类错误通常发生在结果已输出之后，属于"收尾写入失败"，
 * 不应把整个 host query 标记为启动失败（code 1）。
 */
process.on('SIGTERM', () => {
  log('Received SIGTERM, exiting gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  log('Received SIGINT, exiting gracefully');
  process.exit(0);
});

process.on('uncaughtException', (err: unknown) => {
  const errno = err as NodeJS.ErrnoException;
  if (errno?.code === 'EPIPE') {
    process.exit(0);
  }
  if (state.isWithinInterruptGraceWindow() && isInterruptRelatedError(err)) {
    console.error('Suppressing interrupt-related uncaught exception:', err);
    process.exit(0);
  }
  console.error('Uncaught exception:', err);
  // 尝试输出结构化错误，让主进程能收到错误信息而非仅看到 exit code 1
  try { writeOutput({ status: 'error', result: null, error: String(err) }); } catch { /* ignore */ }
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  const errno = reason as NodeJS.ErrnoException;
  if (errno?.code === 'EPIPE') {
    process.exit(0);
  }
  // ProcessTransport closed — can happen if IPC poll races with query completion.
  // The message that triggered this was already consumed from IPC and is lost,
  // but the process should not crash. The main loop will pick up subsequent messages.
  if (reason instanceof Error && /ProcessTransport is not ready/i.test(reason.message)) {
    console.error('[agent-runner] ProcessTransport not ready (non-fatal, query ended):', reason.message);
    return;
  }
  if (state.isWithinInterruptGraceWindow()) {
    console.error('Unhandled rejection during interrupt (non-fatal):', reason);
    return;
  }
  console.error('Unhandled rejection:', reason);
  process.exit(1);
});
main();
