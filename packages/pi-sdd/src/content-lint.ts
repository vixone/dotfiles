import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve, basename } from 'node:path';
import { parseFrontmatter } from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

const Frontmatter = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' }),
  description: Type.String({ minLength: 1, maxLength: 1024, pattern: '\\S' }),
  'disable-model-invocation': Type.Literal(true),
}, { additionalProperties: false });
export type SkillFrontmatter = Static<typeof Frontmatter>;
export type ContentIssue = { code: 'FRONTMATTER' | 'SIZE' | 'FORBIDDEN_TOKEN' | 'LINK'; message: string };

export function parseSkillFrontmatter(text: string): SkillFrontmatter {
  if (!/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(text)) throw new Error('FRONTMATTER: missing header');
  const { frontmatter } = parseFrontmatter<Record<string, unknown>>(text);
  if (!Value.Check(Frontmatter, frontmatter)) throw new Error('FRONTMATTER: invalid explicit skill fields');
  return frontmatter;
}

export async function lintContent({ path, skillName }: { path: string; skillName?: string }): Promise<ContentIssue[]> {
  const text = await readFile(path, 'utf8');
  const issues: ContentIssue[] = [];
  if (basename(path) === 'SKILL.md' || skillName !== undefined) {
    try {
      const fields = parseSkillFrontmatter(text);
      if (skillName !== undefined && fields.name !== skillName) throw new Error('FRONTMATTER: name mismatch');
    } catch (error) {
      issues.push({ code: 'FRONTMATTER', message: error instanceof Error ? error.message : String(error) });
    }
    if (Buffer.byteLength(text) >= 25 * 1024) issues.push({ code: 'SIZE', message: 'Skill must be under 25KB.' });
  }
  const forbidden = /TeamCreate|SendMessage|TodoWrite|team:the-|\$ARGUMENTS|\/start:|Agent Team|\bAskUserQuestion\b|\bSkill\(|\bBash\(/g;
  for (const match of text.matchAll(forbidden)) issues.push({ code: 'FORBIDDEN_TOKEN', message: match[0] });
  const references = new Map<string, string>();
  for (const match of text.matchAll(/^\s*\[([^\]]+)\]:\s*<?([^\s>]+)>?/gm)) references.set((match[1] ?? '').toLowerCase(), match[2] ?? '');
  const links = [...text.matchAll(/!?\[[^\]\n]*\]\(\s*<?([^\s)>]+)>?(?:\s+['"][^\n]*?['"])?\s*\)/g)].map(m => m[1] ?? '');
  for (const match of text.matchAll(/!?\[([^\]\n]+)\]\[([^\]\n]*)\]/g)) {
    const key = (match[2] || match[1] || '').toLowerCase();
    const target = references.get(key);
    if (target === undefined) issues.push({ code: 'LINK', message: `Undefined reference: ${key}` });
    else links.push(target);
  }
  links.push(...references.values());
  for (const link of links) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(link)) continue;
    try {
      const [rawTarget = '', rawAnchor] = link.split('#');
      const target = decodeURIComponent(rawTarget).split('?')[0] ?? '';
      const resolved = target ? resolve(dirname(path), target) : path;
      if (!(await stat(resolved)).isFile()) throw new Error('not a file');
      if (rawAnchor) {
        const linkedText = resolved === path ? text : await readFile(resolved, 'utf8');
        const anchor = decodeURIComponent(rawAnchor);
        const headings = [...linkedText.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)].map(match =>
          (match[1] ?? '').toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/\s/g, '-'));
        const explicit = [...linkedText.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]);
        if (![...headings, ...explicit].includes(anchor)) throw new Error('missing anchor');
      }
    } catch {
      issues.push({ code: 'LINK', message: `Unresolved local link: ${link}` });
    }
  }
  return issues;
}
