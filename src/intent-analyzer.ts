export type MessageIntent = 'stop' | 'correction' | 'continue';

const STOP_KEYWORDS = ['停', '暂停', '停止', '停下', '算了', '取消', '不用了', 'stop', 'cancel', 'abort'];
const CORRECTION_KEYWORDS = ['不对', '错了', '等等', '重来', 'wrong', 'redo'];

const MAX_SHORT_MESSAGE_LENGTH = 50;

export function analyzeIntent(text: string): MessageIntent {
  const trimmed = text.trim();

  if (trimmed.length === 0 || trimmed.length > MAX_SHORT_MESSAGE_LENGTH) {
    return 'continue';
  }

  const lower = trimmed.toLowerCase();

  // Exact match first
  for (const kw of STOP_KEYWORDS) {
    if (lower === kw) return 'stop';
  }
  for (const kw of CORRECTION_KEYWORDS) {
    if (lower === kw) return 'correction';
  }

  // Substring match
  for (const kw of STOP_KEYWORDS) {
    if (lower.includes(kw)) return 'stop';
  }
  for (const kw of CORRECTION_KEYWORDS) {
    if (lower.includes(kw)) return 'correction';
  }

  return 'continue';
}
