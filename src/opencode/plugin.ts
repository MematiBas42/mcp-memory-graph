import { existsSync, writeFileSync, appendFileSync, readFileSync, mkdirSync } from 'node:fs';
import { spawn, execSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename, join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { resolveDbPath } from '../db/db-path.js';
import { resolveNamespace } from '../config/loader.js';
import { formatKeyLine } from '../hooks/recall-format.js';
import {
  tokenize,
  shouldRecall,
  rankMemories,
  formatRecall,
  type MemoryRow,
} from '../hooks/memory-user-prompt.js';
import type {
  PluginInput,
  OpenCodeHooks,
  OpenCodePlugin,
  SystemTransformOutput,
  ChatMessageOutput,
  ToolExecuteAfterInput,
  ToolExecuteAfterOutput,
  CompactingOutput,
  PluginEvent,
} from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface DatabaseAdapter {
  readonly engine: string;
  queryAll<T>(sql: string, params?: unknown[]): T[];
  queryGet<T>(sql: string, params?: unknown[]): T | undefined;
  close(): void;
}

function escapeSqlParam(val: unknown): string {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number') return Number.isFinite(val) ? String(val) : 'NULL';
  if (typeof val === 'boolean') return val ? '1' : '0';
  if (val instanceof Date) return `'${val.toISOString().replace(/'/g, "''")}'`;
  return `'${String(val).replace(/'/g, "''")}'`;
}

function interpolateSql(sql: string, params: unknown[] = []): string {
  let idx = 0;
  return sql.replace(/\?/g, () => {
    if (idx < params.length) {
      return escapeSqlParam(params[idx++]);
    }
    return 'NULL';
  });
}

export async function createDatabaseAdapter(dbPath: string): Promise<DatabaseAdapter | null> {
  const isFilePresent = existsSync(dbPath);

  // ── Katman 1: bun:sqlite (Bun runtime) ──────────────────────────────────
  const isBun =
    typeof (globalThis as any).Bun !== 'undefined' ||
    Boolean(process.versions && (process.versions as any).bun);

  if (isBun && isFilePresent) {
    try {
      // @ts-ignore - bun:sqlite is resolved at runtime in Bun
      const bunSqlite = await import('bun:sqlite');
      const BunDatabase = bunSqlite.Database || bunSqlite.default;
      if (BunDatabase) {
        const bunDb = new BunDatabase(dbPath, { readonly: true });
        let isClosed = false;
        return {
          engine: 'bun:sqlite',
          queryAll<T>(sql: string, params: unknown[] = []): T[] {
            if (isClosed) return [];
            const stmt = bunDb.prepare(sql);
            return (stmt.all(...params) as T[]) || [];
          },
          queryGet<T>(sql: string, params: unknown[] = []): T | undefined {
            if (isClosed) return undefined;
            const stmt = bunDb.prepare(sql);
            const res = stmt.get(...params);
            return (res as T) ?? undefined;
          },
          close(): void {
            if (!isClosed) {
              isClosed = true;
              try {
                bunDb.close();
              } catch {
                // Safe close
              }
            }
          },
        };
      }
    } catch {
      // Fall through to next tier
    }
  }

  // ── Katman 2: better-sqlite3 (Node.js runtime) ──────────────────────────
  if (isFilePresent) {
    try {
      const betterSqliteModule = await import('better-sqlite3');
      const BetterSqlite3 = betterSqliteModule.default || betterSqliteModule;
      const nodeDb = new BetterSqlite3(dbPath, { readonly: true });
      let isClosed = false;
      return {
        engine: 'better-sqlite3',
        queryAll<T>(sql: string, params: unknown[] = []): T[] {
          if (isClosed) return [];
          const stmt = nodeDb.prepare(sql);
          return (stmt.all(...params) as T[]) || [];
        },
        queryGet<T>(sql: string, params: unknown[] = []): T | undefined {
          if (isClosed) return undefined;
          const stmt = nodeDb.prepare(sql);
          const res = stmt.get(...params);
          return (res as T) ?? undefined;
        },
        close(): void {
          if (!isClosed) {
            isClosed = true;
            try {
              if (nodeDb.open) nodeDb.close();
            } catch {
              // Safe close
            }
          }
        },
      };
    } catch {
      // Fall through to Katman 3
    }
  }

  // Katman 1 fallback if isBun was false but bun:sqlite is available
  if (isFilePresent) {
    try {
      // @ts-ignore
      const bunSqlite = await import('bun:sqlite');
      const BunDatabase = bunSqlite.Database || bunSqlite.default;
      if (BunDatabase) {
        const bunDb = new BunDatabase(dbPath, { readonly: true });
        let isClosed = false;
        return {
          engine: 'bun:sqlite',
          queryAll<T>(sql: string, params: unknown[] = []): T[] {
            if (isClosed) return [];
            const stmt = bunDb.prepare(sql);
            return (stmt.all(...params) as T[]) || [];
          },
          queryGet<T>(sql: string, params: unknown[] = []): T | undefined {
            if (isClosed) return undefined;
            const stmt = bunDb.prepare(sql);
            const res = stmt.get(...params);
            return (res as T) ?? undefined;
          },
          close(): void {
            if (!isClosed) {
              isClosed = true;
              try {
                bunDb.close();
              } catch {
                // Safe close
              }
            }
          },
        };
      }
    } catch {
      // Fall through
    }
  }

  // ── Katman 3: sqlite3 CLI fallback ─────────────────────────────────────
  if (isFilePresent) {
    try {
      // Verify sqlite3 CLI is available and can query dbPath
      execFileSync('sqlite3', [dbPath, 'SELECT 1;'], {
        timeout: 1500,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      let isClosed = false;

      const cliQueryAll = <T>(sql: string, params: unknown[] = []): T[] => {
        if (isClosed) return [];
        const interpolated = interpolateSql(sql, params);
        try {
          const out = execFileSync('sqlite3', ['-json', dbPath, interpolated], {
            encoding: 'utf-8',
            timeout: 3000,
            maxBuffer: 10 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'ignore'],
          });
          const trimmed = out.trim();
          if (!trimmed) return [];
          const parsed = JSON.parse(trimmed);
          return Array.isArray(parsed) ? (parsed as T[]) : [];
        } catch {
          return [];
        }
      };

      const cliQueryGet = <T>(sql: string, params: unknown[] = []): T | undefined => {
        const rows = cliQueryAll<T>(sql, params);
        return rows.length > 0 ? rows[0] : undefined;
      };

      return {
        engine: 'sqlite3-cli',
        queryAll: cliQueryAll,
        queryGet: cliQueryGet,
        close(): void {
          isClosed = true;
        },
      };
    } catch {
      // sqlite3 CLI unavailable, try REST API
    }
  }

  // ── Katman 3 (alt): REST API fallback (http://127.0.0.1:3100) ───────────
  // Only fallback to REST API if dbPath is default/standard or file exists but cannot be opened
  const isDefaultDb = !process.env.MCP_MEMORY_DB_PATH && dbPath === resolveDbPath();
  if (isFilePresent || isDefaultDb) {
    try {
      const res = execFileSync('curl', ['-s', '--max-time', '1', 'http://127.0.0.1:3100/api/stats'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (res && res.includes('total_memories')) {
        let isClosed = false;

        const restQueryAll = <T>(sql: string, params: unknown[] = []): T[] => {
          if (isClosed) return [];
          try {
            if (sql.includes('COUNT(*)')) {
              const out = execFileSync(
                'curl',
                ['-s', '--max-time', '2', 'http://127.0.0.1:3100/api/stats'],
                {
                  encoding: 'utf-8',
                  stdio: ['ignore', 'pipe', 'ignore'],
                },
              );
              const data = JSON.parse(out);
              return [{ cnt: data.total_memories ?? 0 }] as unknown as T[];
            }
            if (sql.includes('memories') && params.length > 0) {
              const term = String(params[0] || '').replace(/%/g, '');
              const url = `http://127.0.0.1:3100/api/search?q=${encodeURIComponent(term)}`;
              const out = execFileSync('curl', ['-s', '--max-time', '2', url], {
                encoding: 'utf-8',
                stdio: ['ignore', 'pipe', 'ignore'],
              });
              const data = JSON.parse(out);
              return (data.results ?? []) as unknown as T[];
            }
            if (sql.includes('memories') && sql.includes('LIMIT 3')) {
              const url = 'http://127.0.0.1:3100/api/memories?limit=3';
              const out = execFileSync('curl', ['-s', '--max-time', '2', url], {
                encoding: 'utf-8',
                stdio: ['ignore', 'pipe', 'ignore'],
              });
              const data = JSON.parse(out);
              return (data.memories ?? []) as unknown as T[];
            }
          } catch {
            // safe ignore
          }
          return [];
        };

        const restQueryGet = <T>(sql: string, params: unknown[] = []): T | undefined => {
          const rows = restQueryAll<T>(sql, params);
          return rows.length > 0 ? rows[0] : undefined;
        };

        return {
          engine: 'rest-api',
          queryAll: restQueryAll,
          queryGet: restQueryGet,
          close(): void {
            isClosed = true;
          },
        };
      }
    } catch {
      // REST API unavailable
    }
  }

  return null;
}

/**
 * OpenCode in-process memory plugin factory.
 *
 * Integrates MCP Memory Graph directly into OpenCode's runtime lifecycle:
 * - Injects standing instructions & relevant memories into system transform.
 * - Performs lightweight task-aware memory recall on user messages.
 * - Tracks tool execution outcomes silently.
 * - Triggers background compaction mining on session compacting events.
 * - Safely disposes SQLite database connection on shutdown.
 */
const TECH_TERMS = new Set([
  'ssh', 'pi', 'pi3', 'api', 'git', 'sql', 'db', 'gpu', 'ram', 'cpu',
  'jwt', 'tui', 'mcp', 'cli', 'pr', 'id', 'env', 'uri', 'url', 'sdk',
  'app', 'dev', 'lan', 'wan', 'ip', 'key', 'gem', 'npm', 'lua', 'vram',
  'rice', 'zsh', 'tmux', 'fish', 'bash', 'node', 'deno', 'bun', 'next',
]);

const TURKISH_STOPWORDS = new Set([
  'bir', 've', 'ile', 'bu', 'su', 'şu', 'o', 'ne', 'mi', 'mu', 'mü', 'mı', 'de', 'da',
  'ki', 'icin', 'için', 'cok', 'çok', 'ama', 'fakat', 'nasil', 'nasıl', 'nedir', 'neydi',
  'diye', 'gibi', 'bana', 'bunu', 'olan', 'olarak', 'tam', 'daha', 'hemen',
]);

export function tokenizeOpenCode(prompt: string): string[] {
  const base = tokenize(prompt);
  const extraTokens = new Set<string>(base);

  for (const w of prompt.toLowerCase().matchAll(/[a-z0-9çğıöşüæøå_-]{2,}/gi)) {
    const t = w[0];
    if (TECH_TERMS.has(t) || (t.length >= 4 && !TURKISH_STOPWORDS.has(t))) {
      extraTokens.add(t);
    }
  }

  return [...extraTokens].slice(0, 8);
}

export const opencodeMemoryPlugin: OpenCodePlugin = async (
  input: PluginInput,
): Promise<OpenCodeHooks> => {
  let adapter: DatabaseAdapter | null = null;
  let dbInitError: string | null = null;
  let adapterEngineName: string = 'none';

  const initAdapter = async (): Promise<DatabaseAdapter | null> => {
    try {
      const dbPath = resolveDbPath();
      if (!existsSync(dbPath)) {
        if (process.env.MCP_MEMORY_DB_PATH) {
          dbInitError = `dbPath not found: ${dbPath}`;
          return null;
        }
      }
      const created = await createDatabaseAdapter(dbPath);
      if (created) {
        adapter = created;
        adapterEngineName = created.engine;
        dbInitError = null;
        return adapter;
      } else {
        dbInitError = existsSync(dbPath)
          ? 'Failed to initialize SQLite database adapter with any engine'
          : `dbPath not found: ${dbPath}`;
      }
    } catch (err) {
      dbInitError = err instanceof Error ? err.stack || err.message : String(err);
      adapter = null;
      adapterEngineName = 'none';
    }
    return null;
  };

  adapter = await initAdapter();

  const getAdapter = async (): Promise<DatabaseAdapter | null> => {
    if (adapter) return adapter;
    return initAdapter();
  };

  const isLoggingEnabled = (): boolean => {
    if (process.env.MCP_OPENCODE_LOG !== undefined) {
      const v = process.env.MCP_OPENCODE_LOG.toLowerCase();
      return v === '1' || v === 'true' || v === 'yes';
    }
    try {
      const cfgPath =
        process.env.MCP_MEMORY_CONFIG_PATH || join(homedir(), '.mcp-memory', 'config.json');
      if (existsSync(cfgPath)) {
        const raw = JSON.parse(readFileSync(cfgPath, 'utf-8'));
        if (raw.hooks?.debug_log !== undefined) return Boolean(raw.hooks.debug_log);
        if (raw.opencode?.debug_log !== undefined) return Boolean(raw.opencode.debug_log);
      }
    } catch {
      // ignore
    }
    return true;
  };

  const logBridge = (event: string, details: Record<string, unknown>): void => {
    if (!isLoggingEnabled()) return;
    try {
      const logPath = join(homedir(), '.mcp-memory', 'plugin.log');
      const entry = JSON.stringify({ ts: new Date().toISOString(), event, ...details }) + '\n';
      appendFileSync(logPath, entry, 'utf-8');
    } catch {
      // Logging must never throw
    }
  };

  const sessionStateDir = join(homedir(), '.mcp-memory', 'sessions');
  if (!existsSync(sessionStateDir)) {
    try {
      mkdirSync(sessionStateDir, { recursive: true });
    } catch {
      // safe ignore
    }
  }

  const getSessionStatePath = (sessionId: string): string => {
    const safeId = (sessionId || 'global').replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(sessionStateDir, `${safeId}.json`);
  };

  const getSessionMutedMemoryIds = (sessionId: string): Set<string> => {
    try {
      const p = getSessionStatePath(sessionId);
      if (existsSync(p)) {
        const data = JSON.parse(readFileSync(p, 'utf-8'));
        if (Array.isArray(data.mutedIds)) {
          return new Set<string>(data.mutedIds);
        }
      }
    } catch {
      // ignore
    }
    return new Set<string>();
  };

  const isSessionMemoryEnabled = (sessionId: string): boolean => {
    try {
      const p = getSessionStatePath(sessionId);
      if (existsSync(p)) {
        const data = JSON.parse(readFileSync(p, 'utf-8'));
        if (data.enabled === false) return false;
      }
    } catch {
      // ignore
    }
    return true;
  };

  const saveSessionRecall = (
    sessionId: string,
    recallInfo: {
      tokens: string[];
      matches: Array<{ id: string; title: string | null; content: string | null; importance_score: number | null }>;
    },
  ): void => {
    try {
      const p = getSessionStatePath(sessionId);
      let state: any = { enabled: true, history: [] };
      if (existsSync(p)) {
        try {
          state = JSON.parse(readFileSync(p, 'utf-8'));
        } catch {
          state = { enabled: true, history: [] };
        }
      }
      state.lastRecall = {
        ts: new Date().toISOString(),
        tokens: recallInfo.tokens,
        matches: recallInfo.matches.map((m) => ({
          id: m.id,
          title: m.title,
          snippet: m.content ? m.content.slice(0, 150) : '',
          importance_score: m.importance_score,
        })),
      };
      state.history = state.history || [];
      for (const m of recallInfo.matches) {
        if (!state.history.some((h: any) => h.id === m.id)) {
          state.history.unshift({
            id: m.id,
            title: m.title,
            snippet: m.content ? m.content.slice(0, 150) : '',
            importance_score: m.importance_score,
            calledAt: new Date().toISOString(),
          });
        }
      }
      if (state.history.length > 20) state.history = state.history.slice(0, 20);
      writeFileSync(p, JSON.stringify(state, null, 2), 'utf-8');
    } catch {
      // safe ignore
    }
  };

  logBridge('plugin.initialized', {
    directory: input.directory,
  });

  return {
    config: async (_cfg: any): Promise<void> => {
      // Configuration hook
    },

    'experimental.chat.system.transform': async (
      _hookInput: any,
      output: SystemTransformOutput,
    ): Promise<void> => {
      if (!output) return;
      if (!Array.isArray(output.system)) {
        output.system = [];
      }

      const activeAdapter = await getAdapter();
      if (!activeAdapter) return;

      try {
        const cwd = input.directory || process.cwd();

        // 1. Resolve namespace
        let namespace: string;
        try {
          namespace = resolveNamespace(cwd);
        } catch {
          namespace = basename(cwd) || '';
        }

        // 2. Detect git branch
        let branch: string | null = null;
        try {
          branch = execSync('git rev-parse --abbrev-ref HEAD', {
            cwd,
            timeout: 2000,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
          }).trim();
        } catch {
          // Not a git repository or git unavailable
        }

        let branchContext = '';
        if (branch && branch !== 'main' && branch !== 'master') {
          const branchParts = branch
            .split('/')
            .filter((p) => !['feature', 'fix', 'chore', 'bugfix', 'hotfix'].includes(p));
          for (const part of branchParts) {
            if (part.length >= 3) {
              try {
                const branchMemories = activeAdapter.queryAll<{ title: string | null }>(
                  `SELECT title FROM memories WHERE parent_id IS NULL AND superseded_at IS NULL
                   AND valid_to IS NULL AND tx_expired IS NULL
                   AND (content LIKE ? OR title LIKE ?) ORDER BY importance_score DESC LIMIT 2`,
                  [`%${part}%`, `%${part}%`],
                );
                const titles = branchMemories.filter((m) => m.title).map((m) => `'${m.title}'`);
                if (titles.length > 0) {
                  branchContext = `Branch "${branch}": ${titles.join(', ')}`;
                  break;
                }
              } catch {
                // Safe ignore query error
              }
            }
          }
        }

        // 3. Count total memories
        let totalCount = 0;
        try {
          const total = activeAdapter.queryGet<{ cnt: number }>(
            'SELECT COUNT(*) as cnt FROM memories WHERE parent_id IS NULL',
          );
          totalCount = total?.cnt ?? 0;
        } catch {
          // Safe ignore count error
        }

        // 4. Fetch top 3 memories (prioritizing current namespace)
        let topMemories: Array<{ id: string; title: string | null; content: string | null }> = [];
        try {
          topMemories = activeAdapter.queryAll<{ id: string; title: string | null; content: string | null }>(
            `SELECT id, title, content FROM memories WHERE parent_id IS NULL AND superseded_at IS NULL
             AND valid_to IS NULL AND tx_expired IS NULL
             ORDER BY (namespace = ?) DESC, importance_score DESC LIMIT 3`,
            [namespace],
          );
        } catch {
          // Safe ignore query error
        }
        const topTitles = topMemories.filter((m) => m.title).map((m) => formatKeyLine(m, 40));

        // 5. Query core_memory table for namespace and global entries
        let coreBlocks: Array<{ scope: string; namespace: string; content: string }> = [];
        try {
          coreBlocks = activeAdapter.queryAll<{
            scope: string;
            namespace: string;
            content: string;
          }>(
            `SELECT scope, namespace, content FROM core_memory
              WHERE TRIM(content) != '' AND (namespace = ? OR namespace = '')
              ORDER BY (namespace = ?) DESC`,
            [namespace, namespace],
          );
        } catch {
          // core_memory table may not exist yet
        }

        const summaryParts: string[] = [`Memory server: ${totalCount} memories`];
        if (branchContext) summaryParts.push(branchContext);
        if (topTitles.length > 0) summaryParts.push(`Key: ${topTitles.join(', ')}`);

        let summaryBlock = summaryParts.join('. ') + '.\n';
        for (const block of coreBlocks) {
          const label = block.namespace
            ? `core memory (${block.scope}/${block.namespace})`
            : `core memory (${block.scope})`;
          summaryBlock += `\n--- ${label} ---\n${block.content}\n`;
        }

        output.system.push(summaryBlock.trim());
        logBridge('system.transform', {
          totalCount,
          topTitles,
          coreCount: coreBlocks.length,
        });
      } catch {
        // System transform must never throw
      }
    },

    'chat.message': async (
      hookInput: any,
      output: ChatMessageOutput,
    ): Promise<void> => {
      if (!output || !Array.isArray(output.parts) || output.parts.length === 0) {
        return;
      }

      const activeAdapter = await getAdapter();
      if (!activeAdapter) return;

      const sessionID =
        (output.parts[0] as any)?.sessionID || hookInput?.sessionID || 'global';

      if (!isSessionMemoryEnabled(sessionID)) {
        logBridge('chat.message.skipped_disabled_session', { sessionID });
        return;
      }

      try {
        const textParts = output.parts
          .filter((p) => p.type === 'text' && typeof p.text === 'string')
          .map((p) => p.text as string);

        const fullPrompt = textParts.join('\n').trim();
        if (!fullPrompt) return;

        const tokens = tokenizeOpenCode(fullPrompt);
        if (!shouldRecall(tokens)) return;

        const likeClauses = tokens.map(() => '(title LIKE ? OR content LIKE ?)').join(' OR ');
        const params: string[] = [];
        for (const t of tokens) {
          params.push(`%${t}%`, `%${t}%`);
        }

        const mutedIds = getSessionMutedMemoryIds(sessionID);

        const rows = activeAdapter.queryAll<MemoryRow>(
          `SELECT id, title, content, importance_score FROM memories
           WHERE parent_id IS NULL AND superseded_at IS NULL
             AND valid_to IS NULL AND tx_expired IS NULL
             AND (${likeClauses})
           LIMIT 50`,
          params,
        );

        // Filter out any memories that the user explicitly muted for this session in the sidebar
        const eligibleRows = mutedIds.size > 0 ? rows.filter((r) => !mutedIds.has(r.id)) : rows;

        const ranked = rankMemories(eligibleRows, tokens, 3);
        const recallBlock = formatRecall(ranked);
        if (recallBlock) {
          const refPart = output.parts[0] as any;
          const messageID = refPart?.messageID || hookInput?.messageID || '';
          const syntheticPartId = `prt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

          saveSessionRecall(sessionID, {
            tokens,
            matches: ranked,
          });

          // Inject as a synthetic part:
          // 1. OpenCode TUI checks `!c.synthetic` and hides it from the user chat bubble (clean UI).
          // 2. OpenCode LLM prep layer passes all non-ignored parts to the model, so the AI sees context cleanly.
          output.parts.unshift({
            id: syntheticPartId,
            sessionID,
            messageID,
            type: 'text',
            text: `[Context Recall]\n${recallBlock}\n`,
            synthetic: true,
          });

          logBridge('chat.message.recall', {
            sessionID,
            tokens,
            matches: ranked.map((r) => r.title),
            syntheticPartId,
          });
        } else {
          logBridge('chat.message.no_match', { tokens });
        }
      } catch {
        // Message hook must never disrupt communication
      }
    },

    'tool.execute.after': async (
      hookInput: ToolExecuteAfterInput,
      output: ToolExecuteAfterOutput,
    ): Promise<void> => {
      try {
        const toolName = hookInput?.tool || '';
        if (toolName === 'memory_search' || toolName.endsWith('memory_search')) {
          const outputText =
            typeof output?.output === 'string'
              ? output.output
              : JSON.stringify(output?.output ?? '');
          const isError = Boolean(
            (output as any)?.isError ||
              (hookInput as any)?.isError ||
              outputText.toLowerCase().startsWith('error') ||
              outputText.includes('"error":'),
          );
          const isEmpty =
            !outputText ||
            outputText.trim() === '' ||
            outputText === '[]' ||
            outputText === '{}' ||
            outputText.includes('No memories found');

          if (isError || isEmpty) {
            if (process.env.DEBUG || process.env.NODE_ENV === 'development') {
              console.debug(
                `[opencode-memory-plugin] tool.execute.after: ${toolName} returned ${
                  isError ? 'error' : 'empty'
                }`,
              );
            }
          }
        }
      } catch {
        // Non-blocking, completely silent
      }
    },

    'experimental.session.compacting': async (
      hookInput: any,
      output: CompactingOutput,
    ): Promise<void> => {
      try {
        const candidatePaths = [
          resolve(__dirname, '../cli/extract-from-transcript.js'),
          resolve(__dirname, '../../dist/cli/extract-from-transcript.js'),
          resolve(__dirname, '../cli/extract-from-transcript.ts'),
          resolve(__dirname, '../../src/cli/extract-from-transcript.ts'),
        ];

        const scriptPath = candidatePaths.find((p) => existsSync(p));
        if (!scriptPath) return;

        const rawTranscriptPath =
          hookInput?.transcript_path || hookInput?.transcriptPath || hookInput?.file;
        let transcriptPath =
          typeof rawTranscriptPath === 'string' && existsSync(rawTranscriptPath)
            ? rawTranscriptPath
            : undefined;

        if (!transcriptPath) {
          const content =
            typeof hookInput?.transcript === 'string'
              ? hookInput.transcript
              : Array.isArray(output?.context) && output.context.length > 0
                ? output.context.join('\n')
                : undefined;

          if (content && content.length >= 100) {
            try {
              const tmpPath = join(
                tmpdir(),
                `opencode-compact-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
              );
              writeFileSync(tmpPath, content, 'utf-8');
              transcriptPath = tmpPath;
            } catch {
              // Ignore temp file error
            }
          }
        }

        if (transcriptPath) {
          const child = spawn('node', [scriptPath, transcriptPath, 'compacting'], {
            detached: true,
            stdio: 'ignore',
            env: {
              ...process.env,
              MCP_MEMORY_CWD: input.directory || process.cwd(),
              MCP_MEMORY_SESSION_ID: hookInput?.sessionID || hookInput?.sessionId || '',
            },
          });
          child.unref();
        }
      } catch {
        // Non-blocking safety fallback
      }
    },

    event: async (_args: { event: PluginEvent }): Promise<void> => {
      // Event listener hook
    },

    dispose: async (): Promise<void> => {
      if (adapter) {
        try {
          adapter.close();
        } catch {
          // Safe cleanup
        } finally {
          adapter = null;
          adapterEngineName = 'none';
        }
      }
    },
  };
};

export default opencodeMemoryPlugin;
