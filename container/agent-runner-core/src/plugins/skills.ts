/**
 * SkillsPlugin — list_skills + load_skill tools.
 *
 * Provides Skill discovery for providers that lack a native Skill tool (e.g. Codex).
 * Scans skillsDirs for SKILL.md files, extracts frontmatter metadata,
 * and exposes tools to list/load them.
 */

import fs from 'fs';
import path from 'path';
import type { ContextPlugin, PluginContext, ToolDefinition, ToolResult } from '../plugin.js';

// ─── Frontmatter parser (minimal YAML subset) ──────────────

interface SkillMeta {
  name: string;
  description: string;
  userInvocable: boolean;
  dir: string;
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    // Handle multi-line description with >
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) {
      result[kv[1]] = kv[2].trim();
    }
  }
  return result;
}

function scanSkills(dirs: string[]): SkillMeta[] {
  const seen = new Set<string>();
  const skills: SkillMeta[] = [];

  // Later dirs override earlier ones (user > project)
  for (const dir of dirs) {
    if (!dir || !fs.existsSync(dir)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      // Follow symlinks
      const entryPath = path.join(dir, entry.name);
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          isDir = fs.statSync(entryPath).isDirectory();
        } catch {
          continue;
        }
      }
      if (!isDir) continue;

      const skillFile = path.join(entryPath, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;

      try {
        const content = fs.readFileSync(skillFile, 'utf-8');
        const fm = parseFrontmatter(content);
        const name = fm['name'] || entry.name;

        // Remove previous entry with same name (override)
        if (seen.has(name)) {
          const idx = skills.findIndex(s => s.name === name);
          if (idx >= 0) skills.splice(idx, 1);
        }
        seen.add(name);

        skills.push({
          name,
          description: fm['description'] || '',
          userInvocable: fm['user-invocable'] !== 'false',
          dir: entryPath,
        });
      } catch {
        // Skip unreadable skills
      }
    }
  }

  return skills;
}

// ─── Plugin ─────────────────────────────────────────────────

export class SkillsPlugin implements ContextPlugin {
  readonly name = 'skills';

  isEnabled(ctx: PluginContext): boolean {
    return (ctx.skillsDirs?.length ?? 0) > 0;
  }

  getTools(ctx: PluginContext): ToolDefinition[] {
    const dirs = ctx.skillsDirs || [];

    return [
      {
        name: 'list_skills',
        description:
          'List all available skills with their name and description. ' +
          'Call this to discover what skills are available before loading one.',
        parameters: {
          type: 'object' as const,
          properties: {},
        },
        execute: async (): Promise<ToolResult> => {
          const skills = scanSkills(dirs);
          if (skills.length === 0) {
            return { content: 'No skills available.' };
          }
          const lines = skills.map(s =>
            `- **${s.name}**: ${s.description}${s.userInvocable ? '' : ' (internal)'}`,
          );
          return { content: `Available skills:\n${lines.join('\n')}` };
        },
      },
      {
        name: 'load_skill',
        description:
          'Load a skill by name. Returns the full SKILL.md content with instructions. ' +
          'After loading, follow the instructions in the returned content.',
        parameters: {
          type: 'object' as const,
          properties: {
            skill_name: {
              type: 'string',
              description: 'Name of the skill to load (from list_skills output)',
            },
          },
          required: ['skill_name'],
        },
        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
          const skillName = args.skill_name as string;
          const skills = scanSkills(dirs);
          const skill = skills.find(s => s.name === skillName);
          if (!skill) {
            const available = skills.map(s => s.name).join(', ');
            return {
              content: `Skill "${skillName}" not found. Available: ${available || 'none'}`,
              isError: true,
            };
          }
          try {
            const content = fs.readFileSync(path.join(skill.dir, 'SKILL.md'), 'utf-8');
            return { content };
          } catch (err) {
            return {
              content: `Failed to read skill "${skillName}": ${err instanceof Error ? err.message : String(err)}`,
              isError: true,
            };
          }
        },
      },
    ];
  }

  getSystemPromptSection(ctx: PluginContext): string {
    const dirs = ctx.skillsDirs || [];
    const skills = scanSkills(dirs);
    if (skills.length === 0) return '';

    const list = skills
      .filter(s => s.userInvocable)
      .map(s => `  - ${s.name}: ${s.description.slice(0, 100)}`)
      .join('\n');

    return (
      '## Skills\n\n' +
      'You have access to specialized skills. ' +
      'Call `list_skills` to see all available skills, then `load_skill` to load one.\n\n' +
      `Available skills:\n${list}\n`
    );
  }
}
