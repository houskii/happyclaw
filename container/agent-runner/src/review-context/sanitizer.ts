/**
 * Content Sanitizer — Two-layer defense against prompt injection and sensitive content.
 *
 * Layer 1: Forbidden-content detection (fail-closed, drops entire section)
 * Layer 2: Injection pattern filtering (lossy, may remove legitimate content)
 *
 * Security positioning: defense-in-depth, not absolute security boundary.
 * The real security boundary is the trust chain: human overlay review → Producer sanitization → this.
 */

import type { ContextSection, Diagnostic } from './types.js';
import { MAX_SECTION_TEXT_LENGTH } from './types.js';

// ─── Canonicalization ────────────────────────────────────

function canonicalize(text: string): string {
  let s = text;
  s = s.normalize('NFKC');
  s = s.replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '');
  s = s.replace(/\s+/g, ' ');
  return s;
}

// ─── Forbidden Content Detection (Layer 1) ───────────────

const FORBIDDEN_PATTERNS: RegExp[] = [
  /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,                    // IPv4
  /\b(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d+\.\d+\b/,   // Private IP
  /(?:mysql|postgres|mongodb|redis):\/\//i,                       // Connection string
  /(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/i,  // Credential assignment
  /(?:SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\s+/i,        // SQL
  /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/,                  // Private key
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/,                               // Long base64 (potential secret)
  /\b\d{15,18}\b/,                                               // Chinese ID number
  /\b1[3-9]\d{9}\b/,                                             // Chinese phone number
];

function containsForbiddenContent(text: string): boolean {
  const canonical = canonicalize(text);
  return FORBIDDEN_PATTERNS.some(re => re.test(canonical));
}

// ─── Injection Pattern Filtering (Layer 2) ───────────────

const INJECTION_PATTERNS: RegExp[] = [
  /```[\s\S]*?```/g,                            // Code blocks
  /\[.*?\]\(.*?\)/g,                            // Markdown links
  /<!--[\s\S]*?-->/g,                           // HTML comments
  /忽略上[文述]/g,                               // Chinese "ignore above"
  /ignore (?:above|previous|all)/gi,            // English "ignore"
  /you (?:must|should|are|will)\b/gi,           // Directive language
  /system:\s*/gi,                               // System prompt injection
  /\bACT AS\b/gi,                               // Role assumption
];

function filterInjectionPatterns(text: string): string {
  let cleaned = text;
  for (const pattern of INJECTION_PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    cleaned = cleaned.replace(pattern, '[filtered]');
  }
  if (cleaned.length > MAX_SECTION_TEXT_LENGTH) {
    cleaned = cleaned.substring(0, MAX_SECTION_TEXT_LENGTH) + '...[truncated]';
  }
  return cleaned;
}

// ─── Public API ──────────────────────────────────────────

export interface SanitizeResult {
  sections: ContextSection[];
  diagnostics: Diagnostic[];
}

/**
 * Sanitize sections: forbidden-content check → injection filtering.
 * Sections failing forbidden-content check are dropped entirely.
 */
export function sanitizeSections(sections: ContextSection[]): SanitizeResult {
  const result: ContextSection[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const section of sections) {
    // Layer 1: Forbidden content — drop entire section
    if (containsForbiddenContent(section.text)) {
      diagnostics.push({
        code: 'security_rejected',
        message: `Section ${section.id} dropped: forbidden content detected`,
        level: 'warn',
      });
      continue;
    }

    // Layer 2: Injection filtering — clean text
    const originalLength = section.text.length;
    const cleanedText = filterInjectionPatterns(section.text);

    if (cleanedText !== section.text) {
      diagnostics.push({
        code: 'sanitization_applied',
        message: `Section ${section.id}: ${originalLength} → ${cleanedText.length} chars`,
        level: 'info',
      });
    }

    if (cleanedText.trim().length === 0) {
      diagnostics.push({
        code: 'sanitization_applied',
        message: `Section ${section.id} emptied after sanitization`,
        level: 'warn',
      });
      continue;
    }

    result.push({ ...section, text: cleanedText });
  }

  return { sections: result, diagnostics };
}
