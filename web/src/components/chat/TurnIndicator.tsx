/**
 * TurnIndicator: shows current turn info and pending queue status.
 * Displayed above the StreamingDisplay when a turn is active.
 */
import { useEffect, useState } from 'react';
import { useChatStore } from '../../stores/chat';

interface TurnIndicatorProps {
  chatJid: string;
}

function formatChannel(channel: string): string {
  if (channel.startsWith('feishu:')) return '飞书';
  if (channel.startsWith('telegram:')) return 'Telegram';
  if (channel.startsWith('qq:')) return 'QQ';
  if (channel.startsWith('web:')) return 'Web';
  return channel;
}

function formatDuration(startedAt: number): string {
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  if (elapsed < 60) return `${elapsed}s`;
  const min = Math.floor(elapsed / 60);
  const sec = elapsed % 60;
  return `${min}m${sec}s`;
}

export function TurnIndicator({ chatJid }: TurnIndicatorProps) {
  const activeTurn = useChatStore((s) => s.activeTurn[chatJid]);
  const pendingBuffer = useChatStore((s) => s.pendingBuffer[chatJid]);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!activeTurn) return;
    const id = window.setInterval(() => {
      setTick((n) => n + 1);
    }, 1000);
    return () => window.clearInterval(id);
  }, [activeTurn]);

  if (!activeTurn && !pendingBuffer) return null;

  const pendingEntries = pendingBuffer
    ? Object.entries(pendingBuffer).filter(([, count]) => count > 0)
    : [];

  if (!activeTurn && pendingEntries.length === 0) return null;

  return (
    <div className="py-2">
      {activeTurn && (
        <div className="flex items-center gap-2 px-4">
          <div className="flex-1 border-t border-dashed border-teal-300/80" />
          <span className="inline-flex items-center gap-1.5 text-[11px] text-teal-700 dark:text-teal-300 whitespace-nowrap">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-teal-500 animate-pulse" />
            <span>Turn</span>
            <span className="opacity-50">·</span>
            <span>{formatChannel(activeTurn.channel)}</span>
            <span className="opacity-50">·</span>
            <span>{activeTurn.messageCount} 条</span>
            <span className="opacity-50">·</span>
            <span>{formatDuration(activeTurn.startedAt)}</span>
            <span className="opacity-50">·</span>
            <span>进行中</span>
          </span>
          <div className="flex-1 border-t border-dashed border-teal-300/80" />
        </div>
      )}
      {pendingEntries.length > 0 && (
        <div className="mt-1 text-center text-[11px] text-amber-600 dark:text-amber-400 px-4">
          {pendingEntries
            .map(([ch, count]) => `${formatChannel(ch)} ${count} 条等待中`)
            .join(' · ')}
        </div>
      )}
    </div>
  );
}
