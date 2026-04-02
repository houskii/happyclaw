import fs from 'fs';
import path from 'path';
import os from 'os';

import { DATA_DIR } from './config.js';
import {
  getSystemSettings,
  type HostIntegrationSource,
} from './runtime-config.js';
import { validateSkillId } from './skill-utils.js';

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
  return [path.join(root, 'settings.json'), `${root}.json`];
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
    for (const entry of fs.readdirSync(skillsPath, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (!validateSkillId(entry.name)) continue;

      const entryPath = path.join(skillsPath, entry.name);
      let realPath = entryPath;
      try {
        if (fs.lstatSync(entryPath).isSymbolicLink()) {
          realPath = fs.realpathSync(entryPath);
        }
      } catch {
        continue;
      }

      if (
        fs.existsSync(path.join(realPath, 'SKILL.md')) ||
        fs.existsSync(path.join(realPath, 'SKILL.md.disabled'))
      ) {
        skills[entry.name] = entryPath;
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err) {
      return {
        servers: {},
        error:
          err instanceof Error
            ? `Failed to parse ${configPath}: ${err.message}`
            : `Failed to parse ${configPath}`,
      };
    }

    const mcpServers =
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

    for (const [id, rawEntry] of Object.entries(mcpServers)) {
      const normalized = normalizeHostMcpEntry(rawEntry);
      if (normalized) {
        servers[id] = normalized;
      }
    }
  }

  return { servers };
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

export function syncHostIntegrationsForUser(userId: string): HostIntegrationSyncResult {
  const sources = getSystemSettings().hostIntegrationSources;
  const sourceStatuses = getHostIntegrationStatuses(sources);

  const desiredSkills: Record<string, SyncedSkillSpec> = {};
  const desiredMcp: Record<string, SyncedMcpSpec> = {};

  for (const source of sources) {
    if (!source.enabled) continue;

    if (source.skillsEnabled) {
      const { skills } = scanSkillsFromSource(source);
      for (const [skillId, sourcePath] of Object.entries(skills)) {
        desiredSkills[skillId] = {
          sourceId: source.id,
          sourcePath,
        };
      }
    }

    if (source.mcpEnabled) {
      const { servers } = scanMcpFromSource(source);
      for (const [serverId, entry] of Object.entries(servers)) {
        desiredMcp[serverId] = {
          sourceId: source.id,
          entry,
        };
      }
    }
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
