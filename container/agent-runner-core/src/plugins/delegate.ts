/**
 * DelegatePlugin — delegate_task tool for cross-model subprocess execution.
 *
 * Spawns an OpenAI runner as a subprocess in an isolated scratch directory
 * (git worktree or tmpdir). The delegate executes the task with restricted
 * permissions and returns results + patch. The parent runner decides whether
 * to apply changes.
 *
 * Design principles:
 * - Process-level isolation (subprocess, not in-process)
 * - Patch computed by parent, not trusted from child
 * - No recursive delegation
 * - Timeout + heartbeat + process group kill
 * - Scratch cleanup on success, preserved on failure for audit
 */

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import type { ContextPlugin, PluginContext, ToolDefinition, ToolResult } from '../plugin.js';
import { OUTPUT_START_MARKER, OUTPUT_END_MARKER } from '../protocol.js';

// ─── Types ─────────────────────────────────────────────────

export type DelegateStatus = 'success' | 'failed' | 'timeout' | 'cancelled';

export interface DelegateJobSpec {
  jobId: string;
  objective: string;
  context?: string;
  focusPaths?: string[];
  scratchDir: string;
  sourceRoot: string;
  repoRoot?: string;
  baseRef?: string;
  capabilityProfile: 'read-only' | 'edit' | 'edit-and-test';
  timeoutMs: number;
  maxTurns: number;
  model?: string;
}

export interface DelegateResult {
  jobId: string;
  status: DelegateStatus;
  summary: string;
  goalMet: boolean;
  changedFiles: Array<{ path: string; status: string }>;
  patch?: { diff: string; stats: { files: number; additions: number; deletions: number } };
  commandLogs?: Array<{ command: string; exitCode: number; output: string }>;
  usage: { durationMs: number; turns: number; toolCalls: number };
  error?: string;
}

// ─── Plugin ────────────────────────────────────────────────

export interface DelegatePluginOptions {
  /** Path to the OpenAI runner entry script. Auto-detected if not specified. */
  openaiRunnerPath?: string;
  /** Disable the plugin entirely. Default: false */
  disabled?: boolean;
}

export class DelegatePlugin implements ContextPlugin {
  readonly name = 'delegate';
  private opts: DelegatePluginOptions;

  constructor(opts: DelegatePluginOptions = {}) {
    this.opts = opts;
  }

  isEnabled(_ctx: PluginContext): boolean {
    if (this.opts.disabled) return false;
    // Need OpenAI credentials for the delegate subprocess
    return !!(process.env.OPENAI_API_KEY || process.env.OPENAI_ACCESS_TOKEN ||
              process.env.CROSSMODEL_OPENAI_ACCESS_TOKEN || process.env.CROSSMODEL_OPENAI_API_KEY);
  }

  getTools(ctx: PluginContext): ToolDefinition[] {
    return [
      {
        name: 'delegate_task',
        description:
          '将编码任务委托给 GPT 子进程执行。GPT 在独立的 git worktree 中工作，' +
          '拥有读写文件和执行命令的能力，完成后返回 patch/diff 和执行结果。' +
          '你（主 runner）审核 patch 后决定是否 apply。' +
          '适用于：独立的编码子任务、代码重构、测试编写、bug 修复等。' +
          '不适用于：需要多轮交互的任务、需要访问外部服务的任务。',
        parameters: {
          type: 'object' as const,
          properties: {
            task: {
              type: 'string',
              description: '任务描述。清晰、完整地描述需要做什么，包含足够上下文让 GPT 独立完成。',
            },
            context: {
              type: 'string',
              description: '可选：额外上下文信息（如相关代码片段、设计决策、约束条件）。',
            },
            files: {
              type: 'array',
              items: { type: 'string' },
              description: '可选：需要关注的文件路径（相对于工作目录），帮助 GPT 聚焦。',
            },
            capability: {
              type: 'string',
              enum: ['read-only', 'edit', 'edit-and-test'],
              description: '权限级别。read-only=只读分析，edit=可修改文件，edit-and-test=可修改+可执行命令（默认）。',
            },
            timeout_sec: {
              type: 'number',
              description: '超时秒数（默认 600，最大 1800）。',
            },
            model: {
              type: 'string',
              description: '可选：指定 GPT 模型（默认使用系统配置的模型）。',
            },
          },
          required: ['task'],
        },
        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
          return this.executeDelegateTask(args, ctx);
        },
      },
    ];
  }

  getSystemPromptSection(_ctx: PluginContext): string {
    return (
      '## 任务委托（delegate_task）\n\n' +
      '你可以使用 `delegate_task` 工具将编码子任务委托给 GPT。GPT 在独立的 git worktree 中执行，' +
      '完成后返回 patch。你负责审核 patch 并决定是否应用到主工作区。\n\n' +
      '委托任务时，提供清晰完整的任务描述和上下文，因为 GPT 没有当前对话历史。\n\n' +
      '收到结果后，审核 patch 内容，确认无误后使用 `git apply` 或手动编辑应用变更。'
    );
  }

  // ─── Internal ────────────────────────────────────────────

  private async executeDelegateTask(
    args: Record<string, unknown>,
    ctx: PluginContext,
  ): Promise<ToolResult> {
    const task = String(args.task || '');
    if (!task.trim()) {
      return { content: 'Error: task is required', isError: true };
    }

    const capability = (args.capability as string) || 'edit-and-test';
    const timeoutSec = Math.min(Math.max(Number(args.timeout_sec) || 600, 10), 1800);
    const timeoutMs = timeoutSec * 1000;
    const model = args.model ? String(args.model) : undefined;
    const context = args.context ? String(args.context) : undefined;
    const files = Array.isArray(args.files) ? args.files.map(String) : undefined;

    const jobId = crypto.randomUUID();
    const sourceRoot = ctx.workspaceGroup;

    // Detect if we're in a git repo
    let repoRoot: string | undefined;
    let baseRef: string | undefined;
    try {
      repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: sourceRoot, encoding: 'utf-8', timeout: 5000,
      }).trim();
      baseRef = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoRoot, encoding: 'utf-8', timeout: 5000,
      }).trim();
    } catch {
      // Not a git repo, will use tmpdir
    }

    // Provision scratch directory
    let scratchDir: string;
    let strategy: 'worktree' | 'tmpdir';

    if (repoRoot && capability !== 'read-only') {
      // Use git worktree for edit tasks in git repos
      strategy = 'worktree';
      scratchDir = path.join(os.tmpdir(), `hc-delegate-${jobId.slice(0, 8)}`);
      try {
        execFileSync('git', ['-C', repoRoot, 'worktree', 'add', '--detach', scratchDir, baseRef || 'HEAD'], {
          encoding: 'utf-8', timeout: 30000,
        });
      } catch (err) {
        return { content: `Error creating git worktree: ${err}`, isError: true };
      }
    } else {
      // tmpdir for read-only or non-git
      strategy = 'tmpdir';
      scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), `hc-delegate-${jobId.slice(0, 8)}-`));
      // Copy focus files if specified
      if (files && files.length > 0) {
        for (const f of files) {
          const src = path.resolve(sourceRoot, f);
          const dst = path.resolve(scratchDir, f);
          try {
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            fs.copyFileSync(src, dst);
          } catch {
            // Skip files that don't exist
          }
        }
      }
    }

    const job: DelegateJobSpec = {
      jobId,
      objective: task,
      context,
      focusPaths: files,
      scratchDir,
      sourceRoot,
      repoRoot,
      baseRef,
      capabilityProfile: capability as DelegateJobSpec['capabilityProfile'],
      timeoutMs,
      maxTurns: capability === 'read-only' ? 16 : 30,
      model,
    };

    // Spawn delegate subprocess
    let result: DelegateResult;
    try {
      result = await this.spawnDelegate(job);
    } catch (err) {
      result = {
        jobId,
        status: 'failed',
        summary: `Delegate process error: ${err}`,
        goalMet: false,
        changedFiles: [],
        usage: { durationMs: 0, turns: 0, toolCalls: 0 },
        error: String(err),
      };
    }

    // Compute authoritative patch from worktree (don't trust child's patch)
    // SECURITY: Use safe git options to prevent config injection from child-modified worktree
    const safeGitEnv = {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      HOME: '/dev/null',
      PATH: process.env.PATH || '/usr/bin:/bin',
    };

    if (strategy === 'worktree' && result.status === 'success') {
      try {
        // Stage new files for diff
        execFileSync('git', ['-C', scratchDir, 'add', '-N', '.'], {
          encoding: 'utf-8', timeout: 10000, env: safeGitEnv,
        });
        const diff = execFileSync('git', [
          '-C', scratchDir,
          '-c', 'core.hooksPath=/dev/null',
          'diff', '--no-ext-diff', '--no-textconv', '--binary', '--find-renames', 'HEAD',
        ], {
          encoding: 'utf-8', timeout: 30000, maxBuffer: 2 * 1024 * 1024, env: safeGitEnv,
        });
        if (diff.trim()) {
          const stats = parseDiffStats(diff);
          result.patch = { diff, stats };

          // Also get changed files list
          const nameStatus = execFileSync('git', [
            '-C', scratchDir,
            'diff', '--no-ext-diff', '--no-textconv', '--name-status', 'HEAD',
          ], {
            encoding: 'utf-8', timeout: 10000, env: safeGitEnv,
          });
          result.changedFiles = nameStatus.trim().split('\n').filter(Boolean).map((line) => {
            const [status, ...pathParts] = line.split('\t');
            return { path: pathParts.join('\t'), status: status || 'M' };
          });
        }
      } catch (err) {
        result.error = (result.error || '') + `\nPatch generation error: ${err}`;
      }
    }

    // Cleanup scratch — always detach worktree from repo to prevent repo pollution
    // On failure, remove worktree link but preserve tmpdir copy for audit
    let cleaned = false;
    if (strategy === 'worktree' && repoRoot) {
      try {
        // Always remove worktree from repo registry to prevent git state pollution
        execFileSync('git', ['-C', repoRoot, 'worktree', 'remove', '--force', scratchDir], {
          encoding: 'utf-8', timeout: 15000, env: safeGitEnv,
        });
        cleaned = true;
      } catch {
        // Fallback: prune stale worktrees
        try {
          execFileSync('git', ['-C', repoRoot, 'worktree', 'prune'], {
            encoding: 'utf-8', timeout: 10000, env: safeGitEnv,
          });
        } catch { /* best-effort */ }
      }
    } else if (result.status === 'success') {
      try {
        // Verify realpath before deletion to prevent symlink attacks
        const realScratch = fs.realpathSync(scratchDir);
        if (realScratch.startsWith(os.tmpdir())) {
          fs.rmSync(realScratch, { recursive: true, force: true });
          cleaned = true;
        }
      } catch { /* best-effort */ }
    }

    // Format result for the parent runner
    return this.formatResult(result, strategy, scratchDir, cleaned);
  }

  private async spawnDelegate(job: DelegateJobSpec): Promise<DelegateResult> {
    const runnerPath = this.resolveRunnerPath();

    // Create sandboxed HOME/TMPDIR/XDG inside scratch to prevent host file access
    const sandboxHome = path.join(job.scratchDir, '.delegate-home');
    const sandboxTmp = path.join(job.scratchDir, '.delegate-tmp');
    fs.mkdirSync(sandboxHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(sandboxTmp, { recursive: true, mode: 0o700 });

    // Resolve OpenAI credentials — prefer OAuth, only pass one auth method
    let authMode: string;
    const authEnv: Record<string, string> = {};
    const oauthToken = process.env.OPENAI_ACCESS_TOKEN || process.env.CROSSMODEL_OPENAI_ACCESS_TOKEN;
    const apiKey = process.env.OPENAI_API_KEY || process.env.CROSSMODEL_OPENAI_API_KEY;
    if (oauthToken) {
      authMode = 'chatgpt_oauth';
      authEnv.OPENAI_ACCESS_TOKEN = oauthToken;
    } else if (apiKey) {
      authMode = 'api_key';
      authEnv.OPENAI_API_KEY = apiKey;
    } else {
      return {
        jobId: job.jobId, status: 'failed', summary: 'No OpenAI credentials available',
        goalMet: false, changedFiles: [], usage: { durationMs: 0, turns: 0, toolCalls: 0 },
        error: 'No OPENAI_ACCESS_TOKEN or OPENAI_API_KEY configured',
      };
    }

    // Build minimal, sandboxed env for the delegate
    // SECURITY: HOME/TMPDIR/XDG all point inside scratch, not host
    const env: Record<string, string> = {
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      HOME: sandboxHome,
      TMPDIR: sandboxTmp,
      TEMP: sandboxTmp,
      TMP: sandboxTmp,
      XDG_CONFIG_HOME: path.join(sandboxHome, '.config'),
      XDG_CACHE_HOME: path.join(sandboxHome, '.cache'),
      XDG_STATE_HOME: path.join(sandboxHome, '.state'),
      NODE_OPTIONS: '--max-old-space-size=512',
      // Prevent git from reading host-level config
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      // Workspace: delegate works in scratch dir
      HAPPYCLAW_WORKSPACE_GROUP: job.scratchDir,
      HAPPYCLAW_WORKSPACE_GLOBAL: job.scratchDir,
      HAPPYCLAW_WORKSPACE_MEMORY: job.scratchDir,
      HAPPYCLAW_WORKSPACE_IPC: path.join(job.scratchDir, '.ipc'),
      // OpenAI credentials — single auth method only
      ...authEnv,
      OPENAI_AUTH_MODE: authMode,
      OPENAI_MODEL: job.model || process.env.OPENAI_MODEL || 'gpt-5.4',
      // Delegate mode marker
      HAPPYCLAW_DELEGATE_MODE: '1',
    };

    // Create IPC directory
    fs.mkdirSync(path.join(job.scratchDir, '.ipc', 'input'), { recursive: true });

    // Build ContainerInput for the delegate
    const delegateInput = JSON.stringify({
      prompt: this.buildDelegatePrompt(job),
      sessionId: undefined,
      groupFolder: `delegate-${job.jobId.slice(0, 8)}`,
      chatJid: `delegate-${job.jobId}`,
      isHome: false,
      isAdminHome: false,
      userId: 'delegate',
    });

    return new Promise<DelegateResult>((resolve, reject) => {
      const startedAt = Date.now();
      let lastActivity = startedAt;
      let outputBuffer = '';
      let stderrBuffer = '';
      let finalResult: string | null = null;
      let killed = false;

      const child: ChildProcess = spawn(process.execPath, [runnerPath], {
        cwd: job.scratchDir,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });

      // Timeout handler
      const timeoutHandle = setTimeout(() => {
        killed = true;
        killProcessTree(child);
      }, job.timeoutMs);

      // Heartbeat: kill if no output for 2 minutes
      const heartbeatHandle = setInterval(() => {
        if (Date.now() - lastActivity > 120_000) {
          killed = true;
          killProcessTree(child);
        }
      }, 15_000);

      // Write input and close stdin
      child.stdin!.write(delegateInput);
      child.stdin!.end();

      const MAX_STDOUT_BYTES = 5 * 1024 * 1024; // 5MB stdout limit
      let totalStdoutBytes = 0;

      // Collect stdout - parse marker-wrapped output
      child.stdout!.on('data', (chunk: Buffer) => {
        lastActivity = Date.now();
        totalStdoutBytes += chunk.length;
        if (totalStdoutBytes > MAX_STDOUT_BYTES) {
          // Kill if stdout exceeds limit (possible DoS)
          killed = true;
          killProcessTree(child);
          return;
        }
        outputBuffer += chunk.toString();

        // Extract ContainerOutput frames
        let startIdx: number;
        while ((startIdx = outputBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = outputBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete frame

          const frameStr = outputBuffer.slice(
            startIdx + OUTPUT_START_MARKER.length,
            endIdx,
          ).trim();
          outputBuffer = outputBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const frame = JSON.parse(frameStr);
            if (frame.status === 'success' && frame.result) {
              finalResult = frame.result;
            } else if (frame.status === 'error') {
              finalResult = null;
              stderrBuffer += `\nRunner error: ${frame.error || 'unknown'}`;
            }
          } catch {
            // Malformed frame
          }
        }
      });

      child.stderr!.on('data', (chunk: Buffer) => {
        lastActivity = Date.now();
        stderrBuffer += chunk.toString();
        // Truncate stderr buffer
        if (stderrBuffer.length > 10000) {
          stderrBuffer = stderrBuffer.slice(-8000);
        }
      });

      child.on('exit', (code, signal) => {
        clearTimeout(timeoutHandle);
        clearInterval(heartbeatHandle);

        const durationMs = Date.now() - startedAt;

        if (killed) {
          resolve({
            jobId: job.jobId,
            status: 'timeout',
            summary: `Delegate timed out after ${Math.round(durationMs / 1000)}s`,
            goalMet: false,
            changedFiles: [],
            usage: { durationMs, turns: 0, toolCalls: 0 },
            error: `Process killed (timeout). Signal: ${signal}, Code: ${code}`,
          });
          return;
        }

        if (code !== 0 && !finalResult) {
          resolve({
            jobId: job.jobId,
            status: 'failed',
            summary: `Delegate process exited with code ${code}`,
            goalMet: false,
            changedFiles: [],
            usage: { durationMs, turns: 0, toolCalls: 0 },
            error: stderrBuffer.slice(-2000) || `Exit code: ${code}`,
          });
          return;
        }

        resolve({
          jobId: job.jobId,
          status: 'success',
          summary: finalResult || '(no output)',
          goalMet: true,
          changedFiles: [],
          usage: { durationMs, turns: 0, toolCalls: 0 },
        });
      });

      child.on('error', (err) => {
        clearTimeout(timeoutHandle);
        clearInterval(heartbeatHandle);
        reject(err);
      });
    });
  }

  private buildDelegatePrompt(job: DelegateJobSpec): string {
    const parts: string[] = [];

    parts.push(`# 任务\n\n${job.objective}`);

    if (job.context) {
      parts.push(`\n## 上下文\n\n${job.context}`);
    }

    if (job.focusPaths && job.focusPaths.length > 0) {
      parts.push(`\n## 重点文件\n\n${job.focusPaths.map((f) => `- ${f}`).join('\n')}`);
    }

    parts.push(`\n## 工作约束`);
    parts.push(`- 你在一个独立的工作目录中，所有修改仅影响此目录`);
    parts.push(`- 当前工作目录就是项目根目录`);

    if (job.capabilityProfile === 'read-only') {
      parts.push(`- **只读模式**：你只能读取和分析文件，不能修改`);
    } else if (job.capabilityProfile === 'edit') {
      parts.push(`- **编辑模式**：你可以读取和修改文件，但不能执行命令`);
    } else {
      parts.push(`- **完整模式**：你可以读取、修改文件并执行命令（如运行测试、构建等）`);
    }

    parts.push(`\n## 输出要求`);
    parts.push(`完成任务后，在最终回复中总结：`);
    parts.push(`1. 做了什么修改（列出文件和关键变更）`);
    parts.push(`2. 是否通过测试（如果执行了测试）`);
    parts.push(`3. 任何需要主 runner 注意的事项`);

    return parts.join('\n');
  }

  private resolveRunnerPath(): string {
    if (this.opts.openaiRunnerPath) return this.opts.openaiRunnerPath;

    // Try common locations
    const candidates = [
      // Relative to agent-runner-core (inside container)
      path.resolve(__dirname, '../../../agent-runner-openai/dist/index.js'),
      // Relative in development
      path.resolve(process.cwd(), '../agent-runner-openai/dist/index.js'),
      // Absolute path from env
      process.env.HAPPYCLAW_OPENAI_RUNNER_PATH,
    ].filter(Boolean) as string[];

    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }

    throw new Error(
      'Cannot find OpenAI runner. Set HAPPYCLAW_OPENAI_RUNNER_PATH or pass openaiRunnerPath option.',
    );
  }

  private formatResult(
    result: DelegateResult,
    strategy: 'worktree' | 'tmpdir',
    scratchDir: string,
    cleaned: boolean,
  ): ToolResult {
    const parts: string[] = [];

    // Header
    const statusEmoji = result.status === 'success' ? '✅' : result.status === 'timeout' ? '⏰' : '❌';
    parts.push(`## Delegate 结果 ${statusEmoji}\n`);
    parts.push(`**状态**: ${result.status} | **耗时**: ${Math.round(result.usage.durationMs / 1000)}s | **策略**: ${strategy}`);

    // Summary
    if (result.summary) {
      parts.push(`\n### GPT 输出摘要\n\n${result.summary.slice(0, 3000)}`);
    }

    // Changed files
    if (result.changedFiles.length > 0) {
      parts.push(`\n### 变更文件 (${result.changedFiles.length})\n`);
      for (const f of result.changedFiles) {
        parts.push(`- \`${f.status}\` ${f.path}`);
      }
    }

    // Patch
    if (result.patch) {
      const { stats } = result.patch;
      parts.push(`\n### Patch (+${stats.additions} -${stats.deletions}, ${stats.files} files)\n`);
      // Truncate patch for display
      const patchPreview = result.patch.diff.length > 5000
        ? result.patch.diff.slice(0, 5000) + '\n... (truncated)'
        : result.patch.diff;
      parts.push('```diff\n' + patchPreview + '\n```');

      if (!cleaned) {
        parts.push(`\n**Scratch 保留在**: \`${scratchDir}\``);
        parts.push(`\n要应用 patch，在主工作区执行：`);
        parts.push('```bash');
        parts.push(`cd ${result.patch ? '你的工作目录' : scratchDir}`);
        parts.push(`git apply <<'PATCH'\n${result.patch.diff.slice(0, 200)}...\nPATCH`);
        parts.push('```');
        parts.push(`或直接从 worktree 复制文件。`);
      }
    }

    // Error
    if (result.error) {
      parts.push(`\n### 错误信息\n\n\`\`\`\n${result.error.slice(0, 1000)}\n\`\`\``);
    }

    return {
      content: parts.join('\n'),
      isError: result.status === 'failed' || result.status === 'timeout',
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────

function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    // Kill entire process group
    if (process.platform !== 'win32') {
      process.kill(-child.pid, 'SIGTERM');
      setTimeout(() => {
        try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already dead */ }
      }, 5000);
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    // Process may already be dead
  }
}

function parseDiffStats(diff: string): { files: number; additions: number; deletions: number } {
  let files = 0;
  let additions = 0;
  let deletions = 0;

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) files++;
    else if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }

  return { files, additions, deletions };
}
