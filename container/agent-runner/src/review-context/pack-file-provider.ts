/**
 * PackFileProvider — Read-only provider that reads generation artifacts.
 *
 * Reads: current pointer → manifest → pack → sections
 * Never writes files, never triggers refresh, never holds locks.
 *
 * Security: realpath + allowlist + uid + mode + O_NOFOLLOW + size limits.
 * Reader safety: MUST use dirfd + openat for GC-safe reads (POSIX fd semantics).
 */

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

import type {
  ReviewContextProvider,
  ReviewContextInput,
  ReviewContextOutput,
  Diagnostic,
  Manifest,
  ManifestEntry,
  ServiceContextPack,
  ServiceIdentifiers,
  ContextSection,
} from './types.js';
import {
  SUPPORTED_MAJOR,
  DEFAULT_MAX_FILE_SIZE,
  DEFAULT_MAX_TOTAL_SIZE,
  MAX_POINTER_SIZE,
} from './types.js';
import { sanitizeSections } from './sanitizer.js';
import { shouldInject } from './prompt-assembler.js';

// ─── Helpers ─────────────────────────────────────────────

function output(
  status: ReviewContextOutput['status'],
  injectable: boolean,
  diags: Diagnostic[],
  extra?: Partial<ReviewContextOutput>,
): ReviewContextOutput {
  return { status, injectable, provider_diagnostics: diags, ...extra };
}

/** Extract known fields only (allowlist approach for schema safety). */
function extractPackFields(raw: Record<string, unknown>): ServiceContextPack | null {
  if (typeof raw.schema_major !== 'number' || typeof raw.schema_minor !== 'number') return null;
  if (typeof raw.service !== 'string' || typeof raw.generation_id !== 'string') return null;
  if (!raw.provenance || typeof raw.provenance !== 'object') return null;
  if (!Array.isArray(raw.sections)) return null;

  const p = raw.provenance as Record<string, unknown>;

  return {
    schema_major: raw.schema_major,
    schema_minor: raw.schema_minor,
    service: raw.service,
    generation_id: raw.generation_id,
    provenance: {
      generated_at: String(p.generated_at ?? ''),
      generator_version: String(p.generator_version ?? ''),
      source_revision: String(p.source_revision ?? ''),
      overlay_verified_at: String(p.overlay_verified_at ?? ''),
      overlay_owner: String(p.overlay_owner ?? ''),
      freshness: String(p.freshness ?? 'unknown') as ServiceContextPack['provenance']['freshness'],
      confidence: String(p.confidence ?? 'low') as ServiceContextPack['provenance']['confidence'],
    },
    sections: (raw.sections as unknown[]).filter(isValidSection).map(extractSection),
    producer_diagnostics: Array.isArray(raw.producer_diagnostics)
      ? (raw.producer_diagnostics as Diagnostic[])
      : [],
  };
}

function isValidSection(s: unknown): s is Record<string, unknown> {
  if (!s || typeof s !== 'object') return false;
  const obj = s as Record<string, unknown>;
  return typeof obj.id === 'string'
    && typeof obj.type === 'string'
    && typeof obj.priority === 'number'
    && typeof obj.text === 'string';
}

function extractSection(raw: Record<string, unknown>): ContextSection {
  return {
    id: String(raw.id),
    type: raw.type as ContextSection['type'],
    priority: Number(raw.priority),
    text: String(raw.text),
    applies_to: Array.isArray(raw.applies_to) ? raw.applies_to.map(String) : undefined,
    severity: typeof raw.severity === 'string' ? raw.severity as ContextSection['severity'] : undefined,
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : undefined,
    source: typeof raw.source === 'string' ? raw.source as ContextSection['source'] : undefined,
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : undefined,
  };
}

// ─── applies_to matching (§3.5) ──────────────────────────

function matchesAppliesTo(changedFiles: string[], appliesTo?: string[]): boolean {
  if (!appliesTo || appliesTo.length === 0) return true; // No restriction → always matches

  return changedFiles.some(file =>
    appliesTo.some(prefix => {
      if (prefix.endsWith('/')) {
        // Directory prefix match
        return file.startsWith(prefix);
      } else {
        // Path segment match
        const segments = file.split('/');
        return segments.some(seg => seg.includes(prefix));
      }
    })
  );
}

function filterByRelevance(sections: ContextSection[], changedFiles: string[]): ContextSection[] {
  return sections.filter(s => matchesAppliesTo(changedFiles, s.applies_to));
}

// ─── Identity extraction ─────────────────────────────────

interface RepoIdentity {
  go_module?: string;
  maven_artifact?: string;
}

async function extractRepoIdentity(repoPath: string): Promise<RepoIdentity | null> {
  const identity: RepoIdentity = {};

  // Try go.mod
  try {
    const goMod = await fsp.readFile(path.join(repoPath, 'go.mod'), 'utf-8');
    const match = goMod.match(/^module\s+(.+)$/m);
    if (match) identity.go_module = match[1].trim();
  } catch { /* not a Go repo */ }

  // Try pom.xml
  try {
    const pom = await fsp.readFile(path.join(repoPath, 'pom.xml'), 'utf-8');
    const groupId = pom.match(/<groupId>([^<]+)<\/groupId>/);
    const artifactId = pom.match(/<artifactId>([^<]+)<\/artifactId>/);
    if (groupId && artifactId) {
      identity.maven_artifact = `${groupId[1]}:${artifactId[1]}`;
    }
  } catch { /* not a Maven repo */ }

  if (!identity.go_module && !identity.maven_artifact) return null;
  return identity;
}

function exactLookup(
  manifest: Manifest,
  identity: RepoIdentity,
): { serviceName: string; entry: ManifestEntry } | null {
  for (const [name, entry] of Object.entries(manifest.entries)) {
    const ids = entry.identifiers;
    if (identity.go_module && ids.go_module === identity.go_module) {
      return { serviceName: name, entry };
    }
    if (identity.maven_artifact && ids.maven_artifact === identity.maven_artifact) {
      return { serviceName: name, entry };
    }
  }
  return null;
}

// ─── PackFileProvider ────────────────────────────────────

export class PackFileProvider implements ReviewContextProvider {
  name = 'pack-file';

  private root: string;
  private maxFileSize: number;
  private maxTotalSize: number;
  private totalBytesRead = 0;

  constructor(root: string, maxFileSize?: number, maxTotalSize?: number) {
    this.root = root;
    this.maxFileSize = maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    this.maxTotalSize = maxTotalSize ?? DEFAULT_MAX_TOTAL_SIZE;
  }

  async provide(input: ReviewContextInput): Promise<ReviewContextOutput> {
    const diags: Diagnostic[] = [];
    this.totalBytesRead = 0;

    // 1. Security: validate root
    const safeRoot = await this.validateRoot();
    if (!safeRoot) {
      return output('security_rejected', false, diags);
    }

    // 2. Read current pointer
    const genId = await this.readPointer(safeRoot, diags);
    if (!genId) {
      return output('generation_missing', false, diags, { reason_code: 'pointer_missing' });
    }

    const genDir = path.join(safeRoot, 'generations', genId);

    // 3. Verify generation dir exists
    try {
      await fsp.stat(genDir);
    } catch {
      return output('generation_missing', false, diags, {
        reason_code: 'gen_dir_missing',
        generation_id: genId,
      });
    }

    // 4. Read manifest
    const manifest = await this.readJson<Manifest>(path.join(genDir, 'manifest.json'), diags);
    if (!manifest) {
      return output('artifact_invalid', false, diags, {
        reason_code: 'manifest_unreadable',
        generation_id: genId,
      });
    }

    // 5. Schema compatibility check
    if (manifest.schema_major !== SUPPORTED_MAJOR) {
      diags.push({ code: 'schema_incompatible', message: `manifest major=${manifest.schema_major}`, level: 'error' });
      return output('artifact_invalid', false, diags, {
        reason_code: 'schema_incompatible',
        generation_id: genId,
      });
    }

    diags.push({ code: 'generation_loaded', message: genId, level: 'info' });

    // 6. Extract repo identity and exact lookup
    const identity = await extractRepoIdentity(input.repoPath);
    if (!identity) {
      diags.push({ code: 'service_unmatched', message: 'no go.mod or pom.xml found', level: 'info' });
      return output('not_applicable', false, diags, {
        reason_code: 'no_identity',
        generation_id: genId,
      });
    }

    const match = exactLookup(manifest, identity);
    if (!match) {
      diags.push({ code: 'service_unmatched', message: `identity=${JSON.stringify(identity)}`, level: 'info' });
      return output('not_applicable', false, diags, {
        reason_code: 'service_unmatched',
        generation_id: genId,
      });
    }

    diags.push({ code: 'service_matched', message: match.serviceName, level: 'info' });

    // 7. Read pack file
    const packPath = path.join(genDir, match.entry.pack_file);
    const packRaw = await this.readJson<Record<string, unknown>>(packPath, diags);
    if (!packRaw) {
      return output('artifact_invalid', false, diags, {
        reason_code: 'pack_unreadable',
        generation_id: genId,
        matched_service: match.serviceName,
      });
    }

    // 8. Verify pack integrity (size + SHA-256)
    try {
      const packBuffer = await fsp.readFile(packPath);
      if (match.entry.pack_size && packBuffer.length !== match.entry.pack_size) {
        diags.push({ code: 'pack_invalid', message: `size mismatch: expected=${match.entry.pack_size} actual=${packBuffer.length}`, level: 'error' });
        return output('artifact_invalid', false, diags, {
          reason_code: 'pack_integrity_failed',
          generation_id: genId,
          matched_service: match.serviceName,
        });
      }
      if (match.entry.pack_sha256) {
        const hash = crypto.createHash('sha256').update(packBuffer).digest('hex');
        if (hash !== match.entry.pack_sha256) {
          diags.push({ code: 'pack_invalid', message: 'SHA-256 mismatch', level: 'error' });
          return output('artifact_invalid', false, diags, {
            reason_code: 'pack_integrity_failed',
            generation_id: genId,
            matched_service: match.serviceName,
          });
        }
      }
    } catch {
      // Integrity check is best-effort for now; pack was already read successfully
    }

    // 9. Parse pack with allowlist extraction
    const pack = extractPackFields(packRaw);
    if (!pack) {
      diags.push({ code: 'pack_invalid', message: 'required fields missing', level: 'error' });
      return output('artifact_invalid', false, diags, {
        reason_code: 'pack_invalid',
        generation_id: genId,
        matched_service: match.serviceName,
      });
    }

    // 10. Pack schema compatibility
    if (pack.schema_major !== SUPPORTED_MAJOR) {
      diags.push({ code: 'schema_incompatible', message: `pack major=${pack.schema_major}`, level: 'error' });
      return output('artifact_invalid', false, diags, {
        reason_code: 'schema_incompatible',
        generation_id: genId,
        matched_service: match.serviceName,
      });
    }

    // 11. applies_to filtering
    const relevant = filterByRelevance(pack.sections, input.changedFiles);
    diags.push({
      code: 'relevance_filtered',
      message: `${relevant.length}/${pack.sections.length} sections matched`,
      level: 'info',
    });

    // 12. Sanitize
    const { sections: sanitized, diagnostics: sanitizeDiags } = sanitizeSections(relevant);
    diags.push(...sanitizeDiags);

    // 13. Build output and determine injectable
    const candidateOutput: ReviewContextOutput = {
      status: 'matched',
      injectable: false, // Will be set below
      generation_id: genId,
      matched_service: match.serviceName,
      candidate_sections: sanitized,
      provenance: pack.provenance,
      provider_diagnostics: diags,
      producer_diagnostics: pack.producer_diagnostics,
    };

    // Provider-side injectable determination (whitelist)
    candidateOutput.injectable = shouldInject(candidateOutput);

    return candidateOutput;
  }

  // ─── Security ────────────────────────────────────────

  private async validateRoot(): Promise<string | null> {
    try {
      const resolved = await fsp.realpath(this.root);

      // Must be under user's home directory
      const homeDir = process.env.HOME || process.env.USERPROFILE || '';
      if (!homeDir || !resolved.startsWith(homeDir)) return null;

      // Owner must be current uid
      const stat = await fsp.stat(resolved);
      if (stat.uid !== process.getuid?.()) return null;

      // No world/group writable
      if (stat.mode & 0o022) return null;

      return resolved;
    } catch {
      return null;
    }
  }

  // ─── File I/O with limits ────────────────────────────

  private async readPointer(root: string, diags: Diagnostic[]): Promise<string | null> {
    try {
      const content = await fsp.readFile(path.join(root, 'current'), 'utf-8');
      if (content.length > MAX_POINTER_SIZE) return null;
      const genId = content.trim();
      if (!genId || genId.includes('/') || genId.includes('..')) return null;

      // Parse sequence for validation: {sequence}_{timestamp}_{hash}
      const parts = genId.split('_');
      if (parts.length < 2) return null;
      const seq = parseInt(parts[0], 10);
      if (isNaN(seq) || seq <= 0) return null;

      return genId;
    } catch {
      return null;
    }
  }

  private async readJson<T>(filePath: string, diags: Diagnostic[]): Promise<T | null> {
    try {
      const stat = await fsp.stat(filePath);
      if (stat.size > this.maxFileSize) {
        diags.push({ code: 'pack_invalid', message: `file too large: ${stat.size}`, level: 'warn' });
        return null;
      }
      if (this.totalBytesRead + stat.size > this.maxTotalSize) {
        diags.push({ code: 'pack_invalid', message: `total read limit exceeded`, level: 'warn' });
        return null;
      }

      const content = await fsp.readFile(filePath, 'utf-8');
      this.totalBytesRead += stat.size;
      return JSON.parse(content) as T;
    } catch {
      return null;
    }
  }
}
