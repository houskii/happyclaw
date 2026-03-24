/**
 * Review Context Provider — Types & Interfaces
 *
 * Cross-project contract types for the Service Context system.
 * Based on TDD v4.2 §3 (Pack Schema v1.0) and §4.1 (Provider Interface).
 */

// ─── Pack Schema (v1.0) ──────────────────────────────────

export interface ServiceContextPack {
  schema_major: number;
  schema_minor: number;
  service: string;
  generation_id: string;
  provenance: PackProvenance;
  sections: ContextSection[];
  producer_diagnostics: Diagnostic[];
}

export interface PackProvenance {
  generated_at: string;
  generator_version: string;
  source_revision: string;
  overlay_verified_at: string;
  overlay_owner: string;
  freshness: FreshnessState;
  confidence: ConfidenceLevel;
}

export type FreshnessState = 'fresh' | 'stale' | 'overlay_only' | 'unknown';
export type ConfidenceLevel = 'high' | 'medium' | 'low';

export interface ContextSection {
  id: string;
  type: 'role' | 'risk' | 'invariant' | 'dependency' | 'hint';
  priority: number;
  text: string;
  applies_to?: string[];
  severity?: 'high' | 'medium' | 'low';
  tags?: string[];
  source?: 'overlay' | 'snapshot';
  updated_at?: string;
}

export interface Diagnostic {
  code: DiagnosticCode;
  /** Must not contain rejected sensitive content — only reason and stats. */
  message: string;
  level: 'info' | 'warn' | 'error';
}

export type DiagnosticCode =
  // Producer side
  | 'overlay_loaded'
  | 'overlay_missing'
  | 'overlay_stale'
  | 'snapshot_loaded'
  | 'snapshot_missing'
  | 'snapshot_stale'
  | 'extraction_failed'
  | 'sanitization_applied'
  // Provider side
  | 'generation_loaded'
  | 'service_matched'
  | 'service_unmatched'
  | 'schema_incompatible'
  | 'pack_missing'
  | 'pack_invalid'
  | 'security_rejected'
  | 'relevance_filtered';

// ─── Manifest Schema (v1.0) ──────────────────────────────

export interface Manifest {
  schema_major: number;
  schema_minor: number;
  generation_id: string;
  generated_at: string;
  generator_version: string;
  entries: Record<string, ManifestEntry>;
}

export interface ManifestEntry {
  pack_file: string;
  pack_size: number;
  pack_sha256: string;
  identifiers: ServiceIdentifiers;
}

export interface ServiceIdentifiers {
  go_module?: string;
  maven_artifact?: string;
}

// ─── Provider Interface (§4.1) ───────────────────────────

export interface ReviewContextInput {
  repoPath: string;
  changedFiles: string[];
  baseRev?: string;
  headRev?: string;
}

export interface ReviewContextOutput {
  status: ReviewContextStatus;
  injectable: boolean;
  reason_code?: string;
  generation_id?: string;
  matched_service?: string;
  candidate_sections?: ContextSection[];
  provenance?: PackProvenance;
  provider_diagnostics: Diagnostic[];
  producer_diagnostics?: Diagnostic[];
}

export type ReviewContextStatus =
  | 'matched'
  | 'not_configured'
  | 'not_applicable'
  | 'generation_missing'
  | 'artifact_invalid'
  | 'security_rejected'
  | 'timeout'
  | 'error';

export interface ReviewContextProvider {
  name: string;
  provide(input: ReviewContextInput): Promise<ReviewContextOutput>;
}

// ─── Configuration ───────────────────────────────────────

export interface ReviewContextConfig {
  provider: 'null' | 'pack-file';
  options?: {
    root?: string;
    maxTokens?: number;
    timeout?: number;
    maxFileSize?: number;
    maxTotalSize?: number;
    maxGenerations?: number;
  };
}

// ─── Constants ───────────────────────────────────────────

export const SUPPORTED_MAJOR = 1;
export const DEFAULT_MAX_TOKENS = 600;
export const DEFAULT_TIMEOUT_MS = 5000;
export const DEFAULT_MAX_FILE_SIZE = 102400;    // 100KB
export const DEFAULT_MAX_TOTAL_SIZE = 512000;   // 500KB
export const MAX_POINTER_SIZE = 256;
export const MAX_SECTION_TEXT_LENGTH = 500;
export const MAX_OVERLAY_AGE_DAYS = 90;

/** Confidence values that allow injection (whitelist). */
export const INJECTABLE_CONFIDENCE = new Set<string>(['high', 'medium']);

/** Freshness values that allow injection (whitelist). */
export const INJECTABLE_FRESHNESS = new Set<string>(['fresh', 'stale', 'overlay_only']);
