import fs from 'fs';
import path from 'path';
import os from 'os';

import { DATA_DIR } from './config.js';
import {
  getSystemSettings,
  type HostIntegrationConflictOverride,
  type HostIntegrationSource,
} from './runtime-config.js';
import { parseFrontmatter, validateSkillId } from './skill-utils.js';

export type HostIntegrationStatusType =
  | 'ok'
  | 'missing'
  | 'unreadable'
  | 'invalid';

export interface HostIntegrationSourceStatus {
  source: HostIntegrationSource;
  status: HostIntegrationStatusType;
  message: string | null;
  resolvedPath: string;
  skillsPath: string;
  mcpConfigPaths: string[];
  skillCount: number;
  mcpCount: number;
}

interface SyncOwnershipManifestV2 {
  version: 2;
  owners: Record<string, string>;
  lastSyncAt: string;
}

interface LegacySkillsHostSyncManifest {
  syncedSkills: string[];
  lastSyncAt: string;
}

interface LegacyMcpHostSyncManifest {
  syncedServers: string[];
  lastSyncAt: string;
}

interface SyncTargetSpec<T> {
  userDir: string;
  readExistingEntries(): Record<string, unknown>;
  applyEntry(id: string, entry: T, exists: boolean): void;
  removeEntry(id: string): void;
  persist(): void;
}

interface SyncedSkillSpec {
  sourceId: string;
  sourcePath: string;
}

interface SyncedMcpSpec {
  sourceId: string;
  entry: Record<string, unknown>;
}

type SyncStats = {
  added: number;
  updated: number;
  deleted: number;
  skipped: number;
};

export interface HostIntegrationSyncResult {
  sources: HostIntegrationSourceStatus[];
  skills: {
    stats: SyncStats;
    total: number;
    owners: Record<string, string>;
    lastSyncAt: string;
  };
  mcp: {
    stats: SyncStats;
    total: number;
    owners: Record<string, string>;
    lastSyncAt: string;
  };
}

interface BaseCollectedCandidate {
  sourceId: string;
  sourceLabel: string;
  sourcePath: string;
}

interface CollectedSkillCandidate extends BaseCollectedCandidate {
  skillPath: string;
}

interface CollectedMcpCandidate extends BaseCollectedCandidate {
  entry: Record<string, unknown>;
}

export interface HostIntegrationConflictCandidate {
  sourceId: string;
  sourceLabel: string;
  sourcePath: string;
}

export interface HostIntegrationConflictItem {
  itemId: string;
  mode: 'auto' | 'pinned';
  pinnedSourceId: string | null;
  effectiveSourceId: string | null;
  effectiveSourceLabel: string | null;
  effectiveSourcePath: string | null;
  warning: string | null;
  candidates: HostIntegrationConflictCandidate[];
}

export interface SkillHostVariantDetail {
  itemId: string;
  sourceId: string;
  sourceLabel: string;
  sourcePath: string;
  content: string;
  enabled: boolean;
  name: string;
  description: string;
}

export interface McpHostVariantDetail {
  itemId: string;
  sourceId: string;
  sourceLabel: string;
  sourcePath: string;
  entry: Record<string, unknown>;
}

function expandHomePath(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function getSourceSkillsPath(source: HostIntegrationSource): string {
  return path.join(expandHomePath(source.path), 'skills');
}

function getSourceMcpConfigPaths(source: HostIntegrationSource): string[] {
  const root = expandHomePath(source.path);
  return [
    path.join(root, 'settings.json'),
    path.join(root, 'config.toml'),
    `${root}.json`,
  ];
}

function getSkillsDirForUser(userId: string): string {
  return path.join(DATA_DIR, 'skills', userId);
}

function getMcpDirForUser(userId: string): string {
  return path.join(DATA_DIR, 'mcp-servers', userId);
}

function getSkillsLegacyManifestPath(userId: string): string {
  return path.join(getSkillsDirForUser(userId), '.host-sync.json');
}

function getSkillsV2ManifestPath(userId: string): string {
  return path.join(getSkillsDirForUser(userId), '.host-sync.v2.json');
}

function getMcpLegacyManifestPath(userId: string): string {
  return path.join(getMcpDirForUser(userId), '.host-sync.json');
}

function getMcpV2ManifestPath(userId: string): string {
  return path.join(getMcpDirForUser(userId), '.host-sync.v2.json');
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function readOwnershipManifest(
  v2Path: string,
  legacyPath: string,
  legacyOwnerId: string,
  legacyField: 'syncedSkills' | 'syncedServers',
): SyncOwnershipManifestV2 {
  const manifest = readJsonFile<SyncOwnershipManifestV2>(v2Path);
  if (manifest?.version === 2 && manifest.owners) {
    return manifest;
  }

  const legacy = readJsonFile<Record<string, unknown>>(legacyPath);
  const syncedIds = Array.isArray(legacy?.[legacyField])
    ? (legacy[legacyField] as unknown[])
    : [];

  const owners: Record<string, string> = {};
  for (const id of syncedIds) {
    if (typeof id === 'string' && id) {
      owners[id] = legacyOwnerId;
    }
  }

  return {
    version: 2,
    owners,
    lastSyncAt:
      typeof legacy?.lastSyncAt === 'string' ? legacy.lastSyncAt : '',
  };
}

function writeOwnershipManifest(
  v2Path: string,
  legacyPath: string,
  owners: Record<string, string>,
  lastSyncAt: string,
  legacyField: 'syncedSkills' | 'syncedServers',
): void {
  fs.mkdirSync(path.dirname(v2Path), { recursive: true });
  fs.writeFileSync(
    v2Path,
    JSON.stringify(
      {
        version: 2,
        owners,
        lastSyncAt,
      } satisfies SyncOwnershipManifestV2,
      null,
      2,
    ),
  );

  const legacyPayload =
    legacyField === 'syncedSkills'
      ? { syncedSkills: Object.keys(owners), lastSyncAt }
      : { syncedServers: Object.keys(owners), lastSyncAt };
  fs.writeFileSync(legacyPath, JSON.stringify(legacyPayload, null, 2));
}

function scanSkillsFromSource(
  source: HostIntegrationSource,
): { skills: Record<string, string>; error?: string } {
  const skillsPath = getSourceSkillsPath(source);
  if (!fs.existsSync(skillsPath)) {
    return { skills: {} };
  }

  const skills: Record<string, string> = {};
  try {
    const queue: Array<{ dir: string; depth: number }> = [{ dir: skillsPath, depth: 0 }];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) continue;

      let realDir = current.dir;
      try {
        realDir = fs.realpathSync(current.dir);
      } catch {
        realDir = current.dir;
      }
      if (visited.has(realDir)) continue;
      visited.add(realDir);

      for (const entry of fs.readdirSync(current.dir, { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

        const entryPath = path.join(current.dir, entry.name);
        let resolvedEntryPath = entryPath;
        try {
          if (fs.lstatSync(entryPath).isSymbolicLink()) {
            resolvedEntryPath = fs.realpathSync(entryPath);
          }
        } catch {
          continue;
        }

        const skillFileExists =
          fs.existsSync(path.join(resolvedEntryPath, 'SKILL.md')) ||
          fs.existsSync(path.join(resolvedEntryPath, 'SKILL.md.disabled'));
        if (skillFileExists && validateSkillId(entry.name)) {
          skills[entry.name] = entryPath;
        }

        if (current.depth < 2) {
          queue.push({ dir: entryPath, depth: current.depth + 1 });
        }
      }
    }
    return { skills };
  } catch (err) {
    return {
      skills: {},
      error: err instanceof Error ? err.message : 'Failed to read skills path',
    };
  }
}

function parseTomlScalar(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);

  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed.replace(/^"(.*)"$/, '$1');
  }
}

function parseCodexMcpToml(content: string): Record<string, Record<string, unknown>> {
  const servers: Record<string, Record<string, unknown>> = {};
  let currentServerId: string | null = null;
  let currentSubsection: 'root' | 'env' | 'headers' | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      const parts = sectionMatch[1]
        .split('.')
        .map((part) => part.trim())
        .filter(Boolean);
      if (parts[0] !== 'mcp_servers' || parts.length < 2) {
        currentServerId = null;
        currentSubsection = null;
        continue;
      }

      currentServerId = parts[1];
      if (!servers[currentServerId]) servers[currentServerId] = {};

      if (parts.length === 2) currentSubsection = 'root';
      else if (parts[2] === 'env') currentSubsection = 'env';
      else if (parts[2] === 'headers') currentSubsection = 'headers';
      else currentSubsection = null;
      continue;
    }

    if (!currentServerId || !currentSubsection) continue;

    const assignmentMatch = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!assignmentMatch) continue;

    const [, key, rawValue] = assignmentMatch;
    const parsedValue = parseTomlScalar(rawValue);
    const server = servers[currentServerId]!;

    if (currentSubsection === 'root') {
      server[key] = parsedValue;
      continue;
    }

    const bagKey = currentSubsection;
    const currentBag =
      server[bagKey] && typeof server[bagKey] === 'object' && !Array.isArray(server[bagKey])
        ? (server[bagKey] as Record<string, unknown>)
        : {};
    currentBag[key] = parsedValue;
    server[bagKey] = currentBag;
  }

  return servers;
}

function normalizeHostMcpEntry(
  raw: unknown,
): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const isHttpType = entry.type === 'http' || entry.type === 'sse';

  if (isHttpType) {
    if (typeof entry.url !== 'string' || !entry.url) return null;
    const normalized: Record<string, unknown> = {
      type: entry.type,
      url: entry.url,
    };
    if (
      entry.headers &&
      typeof entry.headers === 'object' &&
      !Array.isArray(entry.headers)
    ) {
      normalized.headers = entry.headers;
    }
    return normalized;
  }

  if (typeof entry.command !== 'string' || !entry.command) return null;
  const normalized: Record<string, unknown> = {
    command: entry.command,
  };
  if (Array.isArray(entry.args)) normalized.args = entry.args;
  if (entry.env && typeof entry.env === 'object' && !Array.isArray(entry.env)) {
    normalized.env = entry.env;
  }
  return normalized;
}

function scanMcpFromSource(
  source: HostIntegrationSource,
): { servers: Record<string, Record<string, unknown>>; error?: string } {
  const configPaths = getSourceMcpConfigPaths(source);
  const servers: Record<string, Record<string, unknown>> = {};

  for (const configPath of configPaths) {
    if (!fs.existsSync(configPath)) continue;
    let mcpServers: Record<string, unknown> = {};
    try {
      const content = fs.readFileSync(configPath, 'utf8');
      if (configPath.endsWith('.toml')) {
        mcpServers = parseCodexMcpToml(content);
      } else {
        const parsed = JSON.parse(content);
        mcpServers =
          parsed &&
          typeof parsed === 'object' &&
          !Array.isArray(parsed) &&
          typeof (parsed as Record<string, unknown>).mcpServers === 'object' &&
          (parsed as Record<string, unknown>).mcpServers !== null &&
          !Array.isArray((parsed as Record<string, unknown>).mcpServers)
            ? ((parsed as Record<string, unknown>).mcpServers as Record<
                string,
                unknown
              >)
            : {};
      }
    } catch (err) {
      return {
        servers: {},
        error:
          err instanceof Error
            ? `Failed to parse ${configPath}: ${err.message}`
            : `Failed to parse ${configPath}`,
      };
    }

    for (const [id, rawEntry] of Object.entries(mcpServers)) {
      const normalized = normalizeHostMcpEntry(rawEntry);
      if (normalized) {
        servers[id] = normalized;
      }
    }
  }

  return { servers };
}

function getConflictOverrideMap(
  kind: HostIntegrationConflictOverride['kind'],
): Map<string, HostIntegrationConflictOverride> {
  const overrides =
    getSystemSettings().hostIntegrationConflictSettings?.overrides ?? [];
  return new Map(
    overrides
      .filter((item) => item.kind === kind)
      .map((item) => [item.itemId, item]),
  );
}

function buildSkillCandidates(
  sources: HostIntegrationSource[],
): Record<string, CollectedSkillCandidate[]> {
  const byId: Record<string, CollectedSkillCandidate[]> = {};

  for (const source of sources) {
    if (!source.enabled || !source.skillsEnabled) continue;
    const { skills } = scanSkillsFromSource(source);
    for (const [skillId, skillPath] of Object.entries(skills)) {
      const bucket = byId[skillId] ?? [];
      bucket.push({
        sourceId: source.id,
        sourceLabel: source.label,
        sourcePath: source.path,
        skillPath,
      });
      byId[skillId] = bucket;
    }
  }

  return byId;
}

function getSkillCandidatesForItem(itemId: string): CollectedSkillCandidate[] {
  const sources = getSystemSettings().hostIntegrationSources;
  return buildSkillCandidates(sources)[itemId] ?? [];
}

function getMcpCandidatesForItem(itemId: string): CollectedMcpCandidate[] {
  const sources = getSystemSettings().hostIntegrationSources;
  return buildMcpCandidates(sources)[itemId] ?? [];
}

function buildMcpCandidates(
  sources: HostIntegrationSource[],
): Record<string, CollectedMcpCandidate[]> {
  const byId: Record<string, CollectedMcpCandidate[]> = {};

  for (const source of sources) {
    if (!source.enabled || !source.mcpEnabled) continue;
    const { servers } = scanMcpFromSource(source);
    for (const [serverId, entry] of Object.entries(servers)) {
      const bucket = byId[serverId] ?? [];
      bucket.push({
        sourceId: source.id,
        sourceLabel: source.label,
        sourcePath: source.path,
        entry,
      });
      byId[serverId] = bucket;
    }
  }

  return byId;
}

function resolveCandidateSelection<T extends BaseCollectedCandidate>(
  kind: HostIntegrationConflictOverride['kind'],
  itemId: string,
  candidates: T[],
): {
  selected: T | null;
  mode: 'auto' | 'pinned';
  pinnedSourceId: string | null;
  warning: string | null;
} {
  const override = getConflictOverrideMap(kind).get(itemId);
  if (override?.mode === 'pinned') {
    const pinned = candidates.find(
      (candidate) => candidate.sourceId === override.pinnedSourceId,
    );
    if (pinned) {
      return {
        selected: pinned,
        mode: 'pinned',
        pinnedSourceId: override.pinnedSourceId ?? null,
        warning: null,
      };
    }
    return {
      selected: candidates.at(-1) ?? null,
      mode: 'auto',
      pinnedSourceId: override.pinnedSourceId ?? null,
      warning: '固定来源当前不可用，已临时回退自动模式',
    };
  }

  return {
    selected: candidates.at(-1) ?? null,
    mode: 'auto',
    pinnedSourceId: null,
    warning: null,
  };
}

function toConflictItem<T extends BaseCollectedCandidate>(
  kind: HostIntegrationConflictOverride['kind'],
  itemId: string,
  candidates: T[],
): HostIntegrationConflictItem {
  const resolution = resolveCandidateSelection(kind, itemId, candidates);
  return {
    itemId,
    mode: resolution.mode,
    pinnedSourceId: resolution.pinnedSourceId,
    effectiveSourceId: resolution.selected?.sourceId ?? null,
    effectiveSourceLabel: resolution.selected?.sourceLabel ?? null,
    effectiveSourcePath: resolution.selected?.sourcePath ?? null,
    warning: resolution.warning,
    candidates: candidates.map((candidate) => ({
      sourceId: candidate.sourceId,
      sourceLabel: candidate.sourceLabel,
      sourcePath: candidate.sourcePath,
    })),
  };
}

export function getHostIntegrationStatuses(
  sources = getSystemSettings().hostIntegrationSources,
): HostIntegrationSourceStatus[] {
  return sources.map((source) => {
    const resolvedPath = expandHomePath(source.path);
    const skillsPath = getSourceSkillsPath(source);
    const mcpConfigPaths = getSourceMcpConfigPaths(source);

    if (!fs.existsSync(resolvedPath)) {
      return {
        source,
        status: 'missing',
        message: 'Source path does not exist',
        resolvedPath,
        skillsPath,
        mcpConfigPaths,
        skillCount: 0,
        mcpCount: 0,
      };
    }

    try {
      const stat = fs.statSync(resolvedPath);
      if (!stat.isDirectory()) {
        return {
          source,
          status: 'invalid',
          message: 'Source path must be a directory',
          resolvedPath,
          skillsPath,
          mcpConfigPaths,
          skillCount: 0,
          mcpCount: 0,
        };
      }
    } catch (err) {
      return {
        source,
        status: 'unreadable',
        message: err instanceof Error ? err.message : 'Failed to access source',
        resolvedPath,
        skillsPath,
        mcpConfigPaths,
        skillCount: 0,
        mcpCount: 0,
      };
    }

    const skillsResult = source.skillsEnabled
      ? scanSkillsFromSource(source)
      : { skills: {} };
    const mcpResult = source.mcpEnabled
      ? scanMcpFromSource(source)
      : { servers: {} };

    const error = skillsResult.error || mcpResult.error;
    return {
      source,
      status: error ? 'invalid' : 'ok',
      message: error ?? null,
      resolvedPath,
      skillsPath,
      mcpConfigPaths,
      skillCount: Object.keys(skillsResult.skills).length,
      mcpCount: Object.keys(mcpResult.servers).length,
    };
  });
}

function copySkillToUser(src: string, dest: string): void {
  let realSrc = src;
  try {
    const lstat = fs.lstatSync(src);
    if (lstat.isSymbolicLink()) {
      realSrc = fs.realpathSync(src);
    }
  } catch {
    realSrc = src;
  }

  fs.cpSync(realSrc, dest, { recursive: true });
}

function syncOwnedEntries<T>(
  previousOwners: Record<string, string>,
  desiredEntries: Record<string, T & { sourceId: string }>,
  spec: SyncTargetSpec<T>,
): { stats: SyncStats; owners: Record<string, string> } {
  fs.mkdirSync(spec.userDir, { recursive: true });

  const existingEntries = spec.readExistingEntries();
  const existingIds = new Set(Object.keys(existingEntries));
  const previousOwnedIds = new Set(Object.keys(previousOwners));
  const desiredIds = new Set(Object.keys(desiredEntries));
  const stats: SyncStats = { added: 0, updated: 0, deleted: 0, skipped: 0 };
  const nextOwners: Record<string, string> = {};

  for (const [id, desired] of Object.entries(desiredEntries)) {
    const exists = existingIds.has(id);
    const wasPreviouslyOwned = previousOwnedIds.has(id);
    if (exists && !wasPreviouslyOwned) {
      stats.skipped++;
      continue;
    }

    spec.applyEntry(id, desired, exists);
    nextOwners[id] = desired.sourceId;
    if (exists) {
      stats.updated++;
    } else {
      stats.added++;
    }
  }

  for (const id of previousOwnedIds) {
    if (!desiredIds.has(id) && existingIds.has(id)) {
      spec.removeEntry(id);
      stats.deleted++;
    }
  }

  spec.persist();
  return { stats, owners: nextOwners };
}

export function getSkillsHostSyncSnapshot(userId: string): {
  owners: Record<string, string>;
  lastSyncAt: string | null;
} {
  const manifest = readOwnershipManifest(
    getSkillsV2ManifestPath(userId),
    getSkillsLegacyManifestPath(userId),
    'anthropic-default',
    'syncedSkills',
  );
  return {
    owners: manifest.owners,
    lastSyncAt: manifest.lastSyncAt || null,
  };
}

export function getMcpHostSyncSnapshot(userId: string): {
  owners: Record<string, string>;
  lastSyncAt: string | null;
} {
  const manifest = readOwnershipManifest(
    getMcpV2ManifestPath(userId),
    getMcpLegacyManifestPath(userId),
    'anthropic-default',
    'syncedServers',
  );
  return {
    owners: manifest.owners,
    lastSyncAt: manifest.lastSyncAt || null,
  };
}

export function getSkillsHostConflictOverview(): HostIntegrationConflictItem[] {
  const sources = getSystemSettings().hostIntegrationSources;
  return Object.entries(buildSkillCandidates(sources))
    .filter(([, candidates]) => candidates.length > 1)
    .map(([itemId, candidates]) => toConflictItem('skill', itemId, candidates))
    .sort((a, b) => a.itemId.localeCompare(b.itemId));
}

export function getMcpHostConflictOverview(): HostIntegrationConflictItem[] {
  const sources = getSystemSettings().hostIntegrationSources;
  return Object.entries(buildMcpCandidates(sources))
    .filter(([, candidates]) => candidates.length > 1)
    .map(([itemId, candidates]) => toConflictItem('mcp', itemId, candidates))
    .sort((a, b) => a.itemId.localeCompare(b.itemId));
}

export function getSkillHostVariant(
  itemId: string,
  sourceId: string,
): SkillHostVariantDetail | null {
  const candidate = getSkillCandidatesForItem(itemId).find(
    (item) => item.sourceId === sourceId,
  );
  if (!candidate) return null;

  const skillMdPath = path.join(candidate.skillPath, 'SKILL.md');
  const skillMdDisabledPath = path.join(candidate.skillPath, 'SKILL.md.disabled');
  const enabled = fs.existsSync(skillMdPath);
  const filePath = enabled ? skillMdPath : skillMdDisabledPath;
  if (!fs.existsSync(filePath)) return null;

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const frontmatter = parseFrontmatter(content);
    return {
      itemId,
      sourceId: candidate.sourceId,
      sourceLabel: candidate.sourceLabel,
      sourcePath: candidate.sourcePath,
      content,
      enabled,
      name: frontmatter.name || itemId,
      description: frontmatter.description || '',
    };
  } catch {
    return null;
  }
}

export function getMcpHostVariant(
  itemId: string,
  sourceId: string,
): McpHostVariantDetail | null {
  const candidate = getMcpCandidatesForItem(itemId).find(
    (item) => item.sourceId === sourceId,
  );
  if (!candidate) return null;

  return {
    itemId,
    sourceId: candidate.sourceId,
    sourceLabel: candidate.sourceLabel,
    sourcePath: candidate.sourcePath,
    entry: candidate.entry,
  };
}

export function syncHostIntegrationsForUser(userId: string): HostIntegrationSyncResult {
  const sources = getSystemSettings().hostIntegrationSources;
  const sourceStatuses = getHostIntegrationStatuses(sources);
  const desiredSkills: Record<string, SyncedSkillSpec> = {};
  const desiredMcp: Record<string, SyncedMcpSpec> = {};
  const skillCandidates = buildSkillCandidates(sources);
  const mcpCandidates = buildMcpCandidates(sources);

  for (const [skillId, candidates] of Object.entries(skillCandidates)) {
    const selected = resolveCandidateSelection('skill', skillId, candidates).selected;
    if (!selected) continue;
    desiredSkills[skillId] = {
      sourceId: selected.sourceId,
      sourcePath: selected.skillPath,
    };
  }

  for (const [serverId, candidates] of Object.entries(mcpCandidates)) {
    const selected = resolveCandidateSelection('mcp', serverId, candidates).selected;
    if (!selected) continue;
    desiredMcp[serverId] = {
      sourceId: selected.sourceId,
      entry: selected.entry,
    };
  }

  const skillsManifest = readOwnershipManifest(
    getSkillsV2ManifestPath(userId),
    getSkillsLegacyManifestPath(userId),
    'anthropic-default',
    'syncedSkills',
  );
  const mcpManifest = readOwnershipManifest(
    getMcpV2ManifestPath(userId),
    getMcpLegacyManifestPath(userId),
    'anthropic-default',
    'syncedServers',
  );

  const skillsDir = getSkillsDirForUser(userId);
  const skillsSync = syncOwnedEntries<SyncedSkillSpec>(
    skillsManifest.owners,
    desiredSkills,
    {
      userDir: skillsDir,
      readExistingEntries() {
        if (!fs.existsSync(skillsDir)) return {};
        const entries: Record<string, SyncedSkillSpec> = {};
        for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            entries[entry.name] = {
              sourceId: '',
              sourcePath: path.join(skillsDir, entry.name),
            };
          }
        }
        return entries;
      },
      applyEntry(id, entry, exists) {
        const dest = path.join(skillsDir, id);
        if (exists) {
          fs.rmSync(dest, { recursive: true, force: true });
        }
        copySkillToUser(entry.sourcePath, dest);
      },
      removeEntry(id) {
        fs.rmSync(path.join(skillsDir, id), { recursive: true, force: true });
      },
      persist() {
        /* no-op */
      },
    },
  );

  const mcpDir = getMcpDirForUser(userId);
  const mcpServersFile = path.join(mcpDir, 'servers.json');
  let mcpData: { servers: Record<string, Record<string, unknown>> } = {
    servers: {},
  };
  try {
    if (fs.existsSync(mcpServersFile)) {
      const parsed = JSON.parse(fs.readFileSync(mcpServersFile, 'utf8')) as {
        servers?: Record<string, Record<string, unknown>>;
      };
      mcpData = {
        servers:
          parsed.servers && typeof parsed.servers === 'object'
            ? parsed.servers
            : {},
      };
    }
  } catch {
    mcpData = { servers: {} };
  }

  const mcpSync = syncOwnedEntries<SyncedMcpSpec>(
    mcpManifest.owners,
    desiredMcp,
    {
      userDir: mcpDir,
      readExistingEntries() {
        return mcpData.servers;
      },
      applyEntry(id, desired, exists) {
        const existing = exists ? mcpData.servers[id] : undefined;
        mcpData.servers[id] = {
          enabled: true,
          syncedFromHost: true,
          addedAt:
            typeof existing?.addedAt === 'string'
              ? existing.addedAt
              : new Date().toISOString(),
          ...desired.entry,
        };
      },
      removeEntry(id) {
        delete mcpData.servers[id];
      },
      persist() {
        fs.mkdirSync(mcpDir, { recursive: true });
        fs.writeFileSync(mcpServersFile, JSON.stringify(mcpData, null, 2));
      },
    },
  );

  const lastSyncAt = new Date().toISOString();
  writeOwnershipManifest(
    getSkillsV2ManifestPath(userId),
    getSkillsLegacyManifestPath(userId),
    skillsSync.owners,
    lastSyncAt,
    'syncedSkills',
  );
  writeOwnershipManifest(
    getMcpV2ManifestPath(userId),
    getMcpLegacyManifestPath(userId),
    mcpSync.owners,
    lastSyncAt,
    'syncedServers',
  );

  return {
    sources: sourceStatuses,
    skills: {
      stats: skillsSync.stats,
      total: Object.keys(desiredSkills).length,
      owners: skillsSync.owners,
      lastSyncAt,
    },
    mcp: {
      stats: mcpSync.stats,
      total: Object.keys(desiredMcp).length,
      owners: mcpSync.owners,
      lastSyncAt,
    },
  };
}
