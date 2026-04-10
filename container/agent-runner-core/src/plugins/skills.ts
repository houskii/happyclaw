/**
 * SkillsPlugin — list_skills + load_skill tools.
 *
 * Provides Skill discovery for providers that lack a native Skill tool.
 */

import fs from 'fs';
import path from 'path';
import type {
  ContextPlugin,
  PluginContext,
  ToolDefinition,
} from '../plugin.js';

interface SkillDefinition {
  name: string;
  description: string;
  userInvocable: boolean;
  dir: string;
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return {};
  }

  const result: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) {
      result[kv[1]] = kv[2].trim();
    }
  }
  return result;
}

function scanSkills(dirs: string[]): SkillDefinition[] {
  const seen = new Set<string>();
  const skills: SkillDefinition[] = [];

  for (const dir of dirs) {
    if (!dir || !fs.existsSync(dir)) {
      continue;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      let isDir = entry.isDirectory();

      if (entry.isSymbolicLink()) {
        try {
          isDir = fs.statSync(entryPath).isDirectory();
        } catch {
          continue;
        }
      }

      if (!isDir) {
        continue;
      }

      const skillFile = path.join(entryPath, 'SKILL.md');
      if (!fs.existsSync(skillFile)) {
        continue;
      }

      try {
        const content = fs.readFileSync(skillFile, 'utf-8');
        const frontmatter = parseFrontmatter(content);
        const name = frontmatter.name || entry.name;

        if (seen.has(name)) {
          const index = skills.findIndex((skill) => skill.name === name);
          if (index >= 0) {
            skills.splice(index, 1);
          }
        }

        seen.add(name);
        skills.push({
          name,
          description: frontmatter.description || '',
          userInvocable: frontmatter['user-invocable'] !== 'false',
          dir: entryPath,
        });
      } catch {
        // Skip unreadable skills.
      }
    }
  }

  return skills;
}

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
          'List all available skills with their name and description. '
          + 'Call this to discover what skills are available before loading one.',
        parameters: {
          type: 'object',
          properties: {},
        },
        execute: async () => {
          const skills = scanSkills(dirs);
          if (skills.length === 0) {
            return { content: 'No skills available.' };
          }

          const lines = skills.map(
            (skill) => `- **${skill.name}**: ${skill.description}${skill.userInvocable ? '' : ' (internal)'}`,
          );
          return { content: `Available skills:\n${lines.join('\n')}` };
        },
      },
      {
        name: 'load_skill',
        description:
          'Load a skill by name. Returns the full SKILL.md content with instructions. '
          + 'After loading, follow the instructions in the returned content.',
        parameters: {
          type: 'object',
          properties: {
            skill_name: {
              type: 'string',
              description: 'Name of the skill to load (from list_skills output)',
            },
          },
          required: ['skill_name'],
        },
        execute: async (args: Record<string, unknown>) => {
          const skillName = getOptionalStringArg(args, 'skill_name');
          if (!skillName) {
            return { content: 'skill_name is required.', isError: true };
          }

          const skills = scanSkills(dirs);
          const skill = skills.find((item) => item.name === skillName);
          if (!skill) {
            const available = skills.map((item) => item.name).join(', ');
            return {
              content: `Skill "${skillName}" not found. Available: ${available || 'none'}`,
              isError: true,
            };
          }

          try {
            const content = fs.readFileSync(
              path.join(skill.dir, 'SKILL.md'),
              'utf-8',
            );
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
    if (skills.length === 0) {
      return '';
    }

    const list = skills
      .filter((skill) => skill.userInvocable)
      .map((skill) => `  - ${skill.name}: ${skill.description.slice(0, 100)}`)
      .join('\n');

    return (
      '## Skills\n\n'
      + 'You have access to specialized skills. '
      + 'Call `list_skills` to see all available skills, then `load_skill` to load one.\n\n'
      + `Available skills:\n${list}\n`
    );
  }
}

function getOptionalStringArg(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}
