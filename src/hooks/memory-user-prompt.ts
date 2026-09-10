#!/usr/bin/env node
// Claude Code UserPromptSubmit hook — task-aware memory recall.

import { existsSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type BetterSqlite3 from 'better-sqlite3';
import { resolveDbPath } from '../db/db-path.js';
import { formatKeyLine } from './recall-format.js';
import { tokenizeText, trLowerCase } from '../lib/nlp.js';

export interface MemoryRow {
  id: string;
  title: string | null;
  content: string | null;
  importance_score: number | null;
}

export function tokenize(prompt: string): string[] {
  return tokenizeText(prompt).slice(0, 8);
}

export function shouldRecall(tokens: string[]): boolean {
  const hasId = tokens.some(t => /^\d{4,7}$/.test(t));
  return hasId || tokens.length >= 2;
}

export function rankMemories(rows: MemoryRow[], tokens: string[], limit = 3): MemoryRow[] {
  return rows
    .map(r => {
      const title = trLowerCase(r.title || '');
      const content = trLowerCase(r.content || '');
      let match = 0; 
      for (const t of tokens) {
        if (title.includes(t)) match += 3;
        if (content.includes(t)) match += 1;
      }
      return { row: r, match, score: match + (r.importance_score ?? 0) };
    })
    .filter(s => s.match >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.row);
}

export function formatRecall(memories: MemoryRow[]): string | null {
  const lines = memories
    .filter(m => m.title)
    .map(m => `- ${formatKeyLine(m, 80)}`);
  if (lines.length === 0) return null;
  return (
    `Possibly-relevant stored memories (search MCP before re-deriving this task):\n` +
    lines.join('\n') +
    `\nRun memory_search / memory_get to load full content — MCP wins over file memory on conflict.\n`
  );
}

async function main(): Promise<void> {
  const stdinTimeout = setTimeout(() => process.exit(0), 5000);
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  clearTimeout(stdinTimeout);

  let input: Record<string, unknown> | null = null;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    process.exit(0);
  }

  const prompt = typeof input?.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt) process.exit(0);

  const tokens = tokenize(prompt);
  if (!shouldRecall(tokens)) process.exit(0);

  const dbPath = resolveDbPath();
  if (!existsSync(dbPath)) process.exit(0);

  let DatabaseConstructor: typeof BetterSqlite3;
  try {
    const mod = await import('better-sqlite3');
    DatabaseConstructor = mod.default;
  } catch {
    process.exit(0);
    return;
  }

  const db = new DatabaseConstructor(dbPath, { readonly: true });
  try {
    const likeClauses = tokens.map(() => '(title LIKE ? OR content LIKE ?)').join(' OR ');
    const params: string[] = [];
    for (const t of tokens) params.push(`%${t}%`, `%${t}%`);

    const rows = db.prepare(
      `SELECT id, title, content, importance_score FROM memories
       WHERE parent_id IS NULL AND superseded_at IS NULL
         AND valid_to IS NULL AND tx_expired IS NULL
         AND (${likeClauses})
       LIMIT 200`
    ).all(...params) as MemoryRow[];

    const block = formatRecall(rankMemories(rows, tokens));
    if (block) process.stdout.write(block);
  } finally {
    db.close();
  }
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch(() => process.exit(0));
}
