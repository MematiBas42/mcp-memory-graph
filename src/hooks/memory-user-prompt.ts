#!/usr/bin/env node
// Claude Code / OpenCode UserPromptSubmit hook — task-aware memory recall.
//
// SessionStart can only surface a GENERIC nudge (it fires before any prompt
// exists). This hook fires WITH the prompt text, so it is the only place a
// recall can be about the task the user just described. It keyword-searches the
// memory DB and prints the top matching titles to stdout, nudging the agent to
// memory_search/memory_get the full content BEFORE re-deriving work.
//
// Upgraded to use exact Unicode word boundaries and optional semantic (Ollama)
// verification to prevent hallucinated matches from substring overlapping.

import { existsSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type BetterSqlite3 from 'better-sqlite3';
import { resolveDbPath } from '../db/db-path.js';
import { formatKeyLine } from './recall-format.js';
import { getConfig } from '../config/loader.js';
import { OllamaEmbeddingProvider } from '../embeddings/ollama.js';

/** Universal stopwords (English + Turkish + Conversational). */
const STOPWORDS = new Set([
  // English
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'you', 'your',
  'can', 'please', 'should', 'would', 'could', 'have', 'has', 'what', 'when',
  'where', 'which', 'about', 'make', 'made', 'use', 'using', 'look', 'looked',
  'then', 'there', 'their', 'they', 'them', 'these', 'those', 'will', 'just',
  'more', 'some', 'been', 'were', 'here', 'also', 'only', 'how', 'why', 'does',
  'done', 'doing', 'want', 'need', 'give', 'take', 'come', 'find', 'tell', 'very',
  'much', 'many', 'well', 'back', 'even', 'good', 'any', 'each', 'such',
  'than', 'both', 'into', 'most', 'other', 'same', 'but',
  // Turkish
  'bir', 've', 'için', 'ile', 'bu', 'da', 'de', 'ise', 'olarak', 'gibi', 'olan',
  'daha', 'nasıl', 'neden', 'ne', 'zaman', 'çok', 'en', 'kadar', 'sonra', 'göre',
  'var', 'yok', 'mi', 'mı', 'mu', 'mü', 'şu', 'şöyle', 'böyle', 'bana', 'sana',
  'onu', 'bunu', 'şunu', 'kendi', 'ilgili', 'hakkında', 'ya', 'ya da', 'veya',
  // Conversational Fillers
  'ok', 'yes', 'sure', 'continue', 'run', 'next', 'pass', 'skip', 'go', 'proceed',
  'thanks', 'hello', 'hi', 'hey', 'bye', 'tamam', 'evet', 'hayır', 'devam', 'geç',
  'hadi', 'sağol', 'teşekkürler', 'merhaba', 'selam', 'now', 'check', 'out',
]);

export interface MemoryRow {
  id: string;
  title: string | null;
  content: string | null;
  importance_score: number | null;
}

export interface ScoredMemoryRow extends MemoryRow {
  match: number;
  score: number;
  similarity?: number;
}

/** Common 3-character technical terms allowed as tokens. */
const TECH_3_CHARS = new Set([
  'api', 'sql', 'gpu', 'cpu', 'ram', 'git', 'mac', 'web', 'app', 'jwt',
  'tui', 'mcp', 'cli', 'ssh', 'lan', 'log', 'bug', 'env', 'dns', 'ssl',
  'tls', 'tcp', 'udp', 'dom', 'css', 'csv', 'pr', 'npm',
]);

/**
 * Safely lowercase a string respecting Turkish dotted/dotless I characters
 * and developer acronyms (API, CLI, UI, GIT, etc.) by canonically normalizing
 * to standard ASCII 'i'.
 */
export function trLowerCase(str: string): string {
  if (!str) return '';
  return str.replace(/[İIı]/gu, 'i').toLowerCase().normalize('NFC');
}

/** 
 * Pull searchable tokens from the prompt: 4-7 digit ids + words >= 4 chars.
 * Uses full Unicode matching to prevent swallowing Turkish characters (ç,ğ,ı,ö,ş,ü).
 */
export function tokenize(prompt: string): string[] {
  const tokens = new Set<string>();
  // ticket/PR ids
  for (const m of prompt.matchAll(/\b\d{4,7}\b/g)) tokens.add(m[0]);
  
  for (const match of prompt.matchAll(/[\p{L}\p{N}_-]{3,}/gu)) {
    const t = trLowerCase(match[0]);
    if (!STOPWORDS.has(t)) {
      if (t.length >= 4 || TECH_3_CHARS.has(t)) {
        tokens.add(t);
      }
    }
  }
  
  return [...tokens].slice(0, 8); // bound the LIKE fan-out
}

/**
 * Gate on task SIGNAL, not word-prefix.
 * Allows single high-signal token (e.g. "Tell me about bge-m3" -> ["bge-m3"]).
 */
export function shouldRecall(tokens: string[]): boolean {
  const hasId = tokens.some(t => /^\d{4,7}$/.test(t));
  if (hasId || tokens.length >= 2) return true;
  if (tokens.length === 1 && (tokens[0].length >= 5 || TECH_3_CHARS.has(tokens[0]))) {
    return true;
  }
  return false;
}

/**
 * Escapes regex special characters to allow safe variable injection.
 */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Checks if a token matches as a distinct word inside the text,
 * respecting Unicode boundaries, hyphens, and Turkish case-folding.
 */
export function matchWordBoundary(text: string, token: string): boolean {
  if (!text || !token) return false;
  const lowerText = trLowerCase(text);
  const lowerToken = trLowerCase(token);
  const escaped = escapeRegex(lowerToken);
  try {
    return new RegExp(`(^|[^\\p{L}\\p{N}_-])${escaped}([^\\p{L}\\p{N}_-]|$)`, 'iu').test(lowerText);
  } catch {
    return new RegExp(`\\b${escaped}\\b`, 'i').test(lowerText);
  }
}

/**
 * Score candidate rows in JS using STRICT word boundaries and Turkish-aware normalization.
 */
export function rankMemories(rows: MemoryRow[], tokens: string[], limit = 5): ScoredMemoryRow[] {
  return rows
    .map(r => {
      let match = 0; // token-derived relevance, importance excluded
      for (const t of tokens) {
        if (matchWordBoundary(r.title || '', t)) match += 3;
        if (matchWordBoundary(r.content || '', t)) match += 1;
      }
      return { ...r, match, score: match + (r.importance_score ?? 0) };
    })
    .filter(s => s.match >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export const MEMORY_PERSISTENCE_DIRECTIVE = `[Memory Persistence Protocol]
When finishing a task or reaching a significant milestone, persist high-signal knowledge worth remembering for future sessions:
- Critical architectural decisions / preferences / project rules -> memory_store (always provide a concise title, document_type: "decision"|"convention")
- Root causes of hard-won bug fixes, recurring mistakes & their solutions -> memory_lesson (fields: {symptom, root_cause, fix, prevention})
- Always-in-context golden rules & hard constraints -> core_memory_append
- Work thread state & next steps -> memory_session_state or memory_session_note
*NOTE: Do NOT persist routine/transient status updates ("file updated", etc.); only record durable insights that will prevent future agents from repeating mistakes or re-deriving decisions.`;

/** Render the recall block, or null when nothing titled survived ranking. */
export function formatRecall(memories: MemoryRow[]): string | null {
  const lines = memories
    .filter(m => m.title)
    .map(m => `- ${formatKeyLine(m, 80)}`);
  if (lines.length === 0) return null;
  return (
    `Possibly-relevant stored memories (search MCP before re-deriving this task):\n` +
    lines.join('\n') +
    `\nRun memory_search / memory_get to load full content — MCP wins over file memory on conflict.` +
    `\nIf a recalled memory appears irrelevant or its title/scope is misleading (containing general keywords, not directing the scope), adjust it via memory_update based on its actual content.\n\n` +
    MEMORY_PERSISTENCE_DIRECTIVE + '\n'
  );
}

// Compute cosine similarity between two Float32Arrays
function computeCosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
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
  db.function('tr_lower', (s: unknown) => (typeof s === 'string' ? trLowerCase(s) : ''));

  try {
    // 1. Fetch wide net using LIKE
    // Using custom deterministic scalar tr_lower() so TitleCase words (Çilek, İşlem, etc.)
    // match lowercase tokens seamlessly without duplicating clauses.
    const clauses = tokens.map(() => '(tr_lower(title) LIKE ? OR tr_lower(content) LIKE ?)');
    const params: string[] = [];
    for (const t of tokens) params.push(`%${t}%`, `%${t}%`);
    const likeClauses = clauses.length > 0 ? clauses.join(' OR ') : '1=0';

    const rows = db.prepare(
      `SELECT id, title, content, importance_score FROM memories
       WHERE parent_id IS NULL AND superseded_at IS NULL
         AND valid_to IS NULL AND tx_expired IS NULL
         AND (${likeClauses})
       LIMIT 200`
    ).all(...params) as MemoryRow[];

    // 2. Strict exact word boundary ranking
    let ranked = rankMemories(rows, tokens, 5);
    
    if (ranked.length === 0) {
      process.exit(0);
    }

    // 3. Fast Semantic / GPU Rerank Verification
    try {
      // 3.A Fast GPU Reranker Path (if mcp-memory-reranker is alive)
      const localRerankUrl = process.env.MCP_MEMORY_RERANKER_URL || 'http://127.0.0.1:8765/rerank';
      let rerankSuccess = false;
      try {
        const resp = await fetch(localRerankUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: prompt,
            documents: ranked.map((r) => (r.title ? r.title + '\n' : '') + (r.content || '')),
          }),
          signal: AbortSignal.timeout(600),
        });
        if (resp.ok) {
          const data = (await resp.json()) as {
            results?: Array<{ index: number; score: number; logit: number }>;
          };
          if (Array.isArray(data?.results) && data.results.length === ranked.length) {
            const reranked: ScoredMemoryRow[] = [];
            for (const item of data.results) {
              const orig = ranked[item.index];
              // Filter out extreme distractors (logit <= -5.0 or score <= 0.005)
              if (item.logit > -5.0 && item.score > 0.005) {
                orig.similarity = item.score;
                reranked.push(orig);
              }
            }
            // Always set ranked to reranked and mark success so complete distractor sets
            // do not fall back to dumping unfiltered keyword matches.
            ranked = reranked.slice(0, 3);
            rerankSuccess = true;
          }
        }
      } catch {
        // Fallback to Ollama embedding check if reranker is inactive
      }

      // 3.B Ollama Embedding Fallback (if reranker was not used)
      if (!rerankSuccess) {
        const isOllama = process.env.MCP_MEMORY_PROVIDER === 'ollama' || 
                         (process.env.MCP_MEMORY_MODEL && !process.env.MCP_MEMORY_PROVIDER);
        if (isOllama) {
          // Fast HTTP check without loading ONNX
          const provider = new OllamaEmbeddingProvider({
            model: process.env.MCP_MEMORY_MODEL || 'bge-m3',
            dimensions: parseInt(process.env.MCP_MEMORY_DIMENSIONS || '1024', 10),
            baseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
            timeoutMs: 1500,
            fetchImpl: (url, init) =>
              fetch(url, { ...init, signal: AbortSignal.timeout(1500) }),
          });
          
          // Timeout semantic check strictly at 1.5s so it never hangs the CLI
          const promptVecPromise = provider.embed(prompt);
          const timeoutPromise = new Promise<null>((r) => setTimeout(() => r(null), 1500));
          const promptVec = await Promise.race([promptVecPromise, timeoutPromise]);
          
          if (promptVec) {
            const pVec = new Float32Array(promptVec);
            const finalRanked: ScoredMemoryRow[] = [];
            
            for (const cand of ranked) {
              try {
                // Load vector from SQLite
                const vecRow = db.prepare('SELECT embedding FROM memories_vec WHERE memory_id = ?').get(cand.id) as { embedding: Buffer } | undefined;
                
                if (vecRow && vecRow.embedding) {
                  const cVec = new Float32Array(vecRow.embedding.buffer, vecRow.embedding.byteOffset, vecRow.embedding.length / 4);
                  const similarity = computeCosineSimilarity(pVec, cVec);
                  
                  // Keep only those with reasonable semantic overlap (> 0.55 threshold)
                  // We use a moderate threshold because prompt vectors are short/conversational
                  // while memory vectors are large/descriptive.
                  if (similarity > 0.55) {
                    cand.similarity = similarity;
                    finalRanked.push(cand);
                  }
                } else {
                  finalRanked.push(cand); // Fallback if no vector
                }
              } catch (err) {
                finalRanked.push(cand); // Fallback on db error
              }
            }
            ranked = finalRanked.sort((a, b) => (b.similarity || 0) - (a.similarity || 0)).slice(0, 3);
          }
        }
      }
    } catch (err) {
      // Silently fall back to exact-match only if Ollama is unreachable
    }

    const block = formatRecall(ranked.slice(0, 3));
    if (block) process.stdout.write(block);
  } finally {
    db.close();
  }
}

// Run only when invoked directly (not when imported by tests). Compare REALPATHS:
// the global install is a symlink, so import.meta.url is symlink-resolved while
// argv[1] is not — a naive compare never matches under nvm's global node_modules.
function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main()
    .then(() => process.exit(0))
    .catch(() => process.exit(0));
}
