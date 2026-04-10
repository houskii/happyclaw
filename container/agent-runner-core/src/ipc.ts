/**
 * IPC utilities for filesystem-based host ↔ agent communication.
 *
 * The host writes JSON files to ipc/{folder}/input/ and the agent polls them.
 * The agent writes JSON files to ipc/{folder}/messages/ and ipc/{folder}/tasks/.
 */

import fs from 'fs';
import path from 'path';
import { emitStreamEvent } from './protocol.js';

export interface IpcConfig {
  inputDir: string;
  closeSentinel: string;
  drainSentinel: string;
  interruptSentinel: string;
  pollIntervalMs: number;
}

export interface IpcMessage {
  text: string;
  images?: Array<{
    data: string;
    mimeType?: string;
  }>;
}

interface RawIpcPayload {
  type?: string;
  text?: string;
  images?: IpcMessage['images'];
}

export function createIpcConfig(
  workspaceIpc: string,
  pollIntervalMs = 500,
): IpcConfig {
  const inputDir = path.join(workspaceIpc, 'input');
  return {
    inputDir,
    closeSentinel: path.join(inputDir, '_close'),
    drainSentinel: path.join(inputDir, '_drain'),
    interruptSentinel: path.join(inputDir, '_interrupt'),
    pollIntervalMs,
  };
}

function checkAndRemoveSentinel(filepath: string): boolean {
  if (fs.existsSync(filepath)) {
    try {
      fs.unlinkSync(filepath);
    } catch {
      // Ignore cleanup errors.
    }
    return true;
  }
  return false;
}

export function shouldClose(config: IpcConfig): boolean {
  return checkAndRemoveSentinel(config.closeSentinel);
}

export function shouldDrain(config: IpcConfig): boolean {
  return checkAndRemoveSentinel(config.drainSentinel);
}

export function shouldInterrupt(config: IpcConfig): boolean {
  return checkAndRemoveSentinel(config.interruptSentinel);
}

/** Atomic write a JSON file to an IPC directory. Returns the filename. */
export function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
}

/** Drain all pending IPC input messages. Returns messages in FIFO order. */
export function drainIpcInput(config: IpcConfig): IpcMessage[] {
  const messages: IpcMessage[] = [];

  try {
    const files = fs
      .readdirSync(config.inputDir)
      .filter((file) => file.endsWith('.json'))
      .sort();

    for (const file of files) {
      const filePath = path.join(config.inputDir, file);
      try {
        const data = JSON.parse(
          fs.readFileSync(filePath, 'utf-8'),
        ) as RawIpcPayload;
        fs.unlinkSync(filePath);

        if (data.type === 'message' && typeof data.text === 'string') {
          messages.push({ text: data.text, images: data.images });
        }
      } catch {
        try {
          fs.unlinkSync(filePath);
        } catch {
          // Ignore broken file cleanup failures.
        }
      }
    }
  } catch {
    // Ignore missing IPC directory or transient read failures.
  }

  return messages;
}

/**
 * Wait for the next IPC message or close sentinel.
 * Returns the message text, or null if close sentinel was received.
 */
export function waitForIpcMessage(
  config: IpcConfig,
): Promise<IpcMessage | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose(config)) {
        resolve(null);
        return;
      }

      const messages = drainIpcInput(config);
      if (messages.length > 0) {
        emitStreamEvent({
          eventType: 'status',
          statusText: 'ipc_message_received',
        });

        if (messages.length === 1) {
          resolve(messages[0]);
        } else {
          resolve({
            text: messages.map((message) => message.text).join('\n'),
            images: messages.flatMap((message) => message.images ?? []),
          });
        }
        return;
      }

      setTimeout(poll, config.pollIntervalMs);
    };

    poll();
  });
}
