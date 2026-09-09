import { existsSync, writeFileSync, appendFileSync, readFileSync, mkdirSync } from 'node:fs';
import { spawn, execSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename, join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { resolveDbPath } from '../db/db-path.js';
import { resolveNamespace } from '../config/loader.js';
import { parseJsonc } from '../cli/init-opencode.js';
import { formatKeyLine } from '../hooks/recall-format.js';
import {
  tokenize,
  shouldRecall,
  rankMemories,
  formatRecall,
  trLowerCase,
  MEMORY_PERSISTENCE_DIRECTIVE,
  type MemoryRow,
  type ScoredMemoryRow,
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

/**
 * Checks whether remote memory mode is configured via environment, config, or OpenCode settings.
 */
export function isRemoteConfigured(directory?: string): boolean {
  if (process.env.MCP_MEMORY_REMOTE_URL || process.env.MCP_REMOTE_URL) {
    return true;
  }
  if (process.env.MCP_MEMORY_MODE === 'remote') {
    return true;
  }

  // Check mcp-memory config.json
  try {
    const cfgPath =
      process.env.MCP_MEMORY_CONFIG_PATH ||
      (directory && existsSync(join(directory, '.mcp-memory', 'config.json'))
        ? join(directory, '.mcp-memory', 'config.json')
        : join(homedir(), '.mcp-memory', 'config.json'));
    if (existsSync(cfgPath)) {
      const raw = JSON.parse(readFileSync(cfgPath, 'utf-8'));
      if (raw?.sharing?.remote_endpoint || raw?.sharing?.mode === 'team' || raw?.remote_endpoint) {
        return true;
      }
    }
  } catch {
    // ignore
  }

  // Check OpenCode configs (project or user)
  try {
    const candidates = [
      directory ? join(directory, 'opencode.jsonc') : null,
      directory ? join(directory, 'opencode.json') : null,
      directory ? join(directory, '.opencode', 'opencode.jsonc') : null,
      directory ? join(directory, '.opencode', 'opencode.json') : null,
      join(homedir(), '.config', 'opencode', 'opencode.jsonc'),
      join(homedir(), '.config', 'opencode', 'opencode.json'),
    ].filter(Boolean) as string[];

    for (const p of candidates) {
      if (existsSync(p)) {
        const raw = readFileSync(p, 'utf-8');
        const parsed = parseJsonc(raw);
        if (parsed?.mcp?.memory?.type === 'remote') {
          return true;
        }
      }
    }
  } catch {
    // ignore
  }

  return false;
}

/**
 * Retrieves the configured remote MCP endpoint URL and optional bearer token.
 */
export function getRemoteEndpoint(directory?: string): { url: string; token?: string } | null {
  const envUrl = process.env.MCP_MEMORY_REMOTE_URL || process.env.MCP_REMOTE_URL;
  if (envUrl) {
    return { url: envUrl, token: process.env.MEMORY_MCP_TOKEN };
  }

  try {
    const cfgPath =
      process.env.MCP_MEMORY_CONFIG_PATH ||
      (directory && existsSync(join(directory, '.mcp-memory', 'config.json'))
        ? join(directory, '.mcp-memory', 'config.json')
        : join(homedir(), '.mcp-memory', 'config.json'));
    if (existsSync(cfgPath)) {
      const raw = JSON.parse(readFileSync(cfgPath, 'utf-8'));
      if (raw?.sharing?.remote_endpoint) {
        return { url: raw.sharing.remote_endpoint };
      }
    }
  } catch {
    // ignore
  }

  try {
    const candidates = [
      directory ? join(directory, 'opencode.jsonc') : null,
      directory ? join(directory, 'opencode.json') : null,
      directory ? join(directory, '.opencode', 'opencode.jsonc') : null,
      directory ? join(directory, '.opencode', 'opencode.json') : null,
      join(homedir(), '.config', 'opencode', 'opencode.jsonc'),
      join(homedir(), '.config', 'opencode', 'opencode.json'),
    ].filter(Boolean) as string[];

    for (const p of candidates) {
      if (existsSync(p)) {
        const raw = readFileSync(p, 'utf-8');
        const parsed = parseJsonc(raw);
        if (parsed?.mcp?.memory?.type === 'remote' && parsed?.mcp?.memory?.url) {
          const authHeader = parsed.mcp.memory.headers?.Authorization;
          let token: string | undefined;
          if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
            token = authHeader.slice(7);
          }
          return { url: parsed.mcp.memory.url, token };
        }
      }
    }
  } catch {
    // ignore
  }

  return null;
}

/**
 * Creates a safe no-op database adapter for remote mode when direct database access is skipped.
 */
export function createNoopDatabaseAdapter(engine: string = 'remote-noop'): DatabaseAdapter {
  return {
    engine,
    queryAll: () => [],
    queryGet: () => undefined,
    close: () => {},
  };
}

/**
 * Creates a remote database adapter that communicates with a remote memory server REST endpoint.
 */
export function createRemoteDatabaseAdapter(remoteUrl: string, token?: string): DatabaseAdapter {
  const baseUrl = remoteUrl.replace(/\/mcp\/?$/, '').replace(/\/+$/, '');
  let isClosed = false;

  let resolvedToken = token;
  if (token && token.startsWith('{env:') && token.endsWith('}')) {
    const envVar = token.slice(5, -1);
    resolvedToken = process.env[envVar];
  }

  const queryAll = <T>(sql: string, params: unknown[] = []): T[] => {
    if (isClosed) return [];
    try {
      const curlArgs = ['-s', '--max-time', '2'];
      if (resolvedToken) {
        curlArgs.push('-H', `Authorization: Bearer ${resolvedToken}`);
      }

      if (sql.includes('COUNT(*)')) {
        const out = execFileSync(
          'curl',
          [...curlArgs, `${baseUrl}/api/stats`],
          { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
        );
        const data = JSON.parse(out);
        return [{ cnt: data.total_memories ?? 0 }] as unknown as T[];
      }
      if (sql.includes('memories') && params.length > 0) {
        const term = String(params[0] || '').replace(/%/g, '');
        const url = `${baseUrl}/api/search?q=${encodeURIComponent(term)}`;
        const out = execFileSync(
          'curl',
          [...curlArgs, url],
          { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
        );
        const data = JSON.parse(out);
        return (data.results ?? []) as unknown as T[];
      }
    } catch {
      // safe ignore
    }
    return [];
  };

  const queryGet = <T>(sql: string, params: unknown[] = []): T | undefined => {
    const rows = queryAll<T>(sql, params);
    return rows.length > 0 ? rows[0] : undefined;
  };

  return {
    engine: 'remote-client',
    queryAll,
    queryGet,
    close(): void {
      isClosed = true;
    },
  };
}

export async function createDatabaseAdapter(
  dbPath: string,
  options?: { isRemote?: boolean; remoteUrl?: string; token?: string },
): Promise<DatabaseAdapter | null> {
  const isRemote =
    options?.isRemote ??
    (process.env.MCP_MEMORY_MODE === 'remote' ||
      Boolean(process.env.MCP_MEMORY_REMOTE_URL || process.env.MCP_REMOTE_URL));

  if (isRemote) {
    const remoteUrl =
      options?.remoteUrl || process.env.MCP_MEMORY_REMOTE_URL || process.env.MCP_REMOTE_URL;
    if (remoteUrl) {
      return createRemoteDatabaseAdapter(remoteUrl, options?.token || process.env.MEMORY_MCP_TOKEN);
    }
    return createNoopDatabaseAdapter();
  }

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
        try {
          if (typeof (bunDb as any).customFunction === 'function') {
            (bunDb as any).customFunction('tr_lower', (s: unknown) => (typeof s === 'string' ? trLowerCase(s) : ''));
          }
        } catch {
          // Safe fallback
        }
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
      try {
        nodeDb.function('tr_lower', (s: unknown) => (typeof s === 'string' ? trLowerCase(s) : ''));
      } catch {
        // Safe fallback
      }
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
  // and NOT in remote mode
  const isDefaultDb = !process.env.MCP_MEMORY_DB_PATH && dbPath === resolveDbPath();
  if ((isFilePresent || isDefaultDb) && !isRemote) {
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

export interface LightweightSearchOptions {
  scope?: string;
  namespace?: string;
  limit?: number;
}

/**
 * Performs a fast, lightweight memory search across title and content tokens,
 * enforcing tenancy rules (namespace isolation) and privacy guards (scope != 'user' by default).
 */
export function searchMemoriesLightweight(
  adapter: DatabaseAdapter,
  tokens: string[],
  options?: LightweightSearchOptions,
): MemoryRow[] {
  if (!adapter || tokens.length === 0) return [];

  const conditions: string[] = [
    'parent_id IS NULL',
    'superseded_at IS NULL',
    'valid_to IS NULL',
    'tx_expired IS NULL',
  ];
  const params: unknown[] = [];

  // Scope filter: respect explicit scope, or enforce privacy guard (exclude user-scoped memories)
  if (options?.scope) {
    conditions.push('scope = ?');
    params.push(options.scope);
  } else {
    conditions.push("scope != 'user'");
  }

  // Namespace filter: restrict to target namespace or global/empty namespace
  if (options?.namespace) {
    conditions.push('(namespace = ? OR namespace IS NULL OR namespace = \'\')');
    params.push(options.namespace);
  }

  // Token matching: use tr_lower for engines that registered it, fallback to standard LIKE
  const hasTrLower = adapter.engine === 'better-sqlite3' || adapter.engine === 'bun:sqlite';
  const likeClauses = tokens
    .map(() =>
      hasTrLower
        ? '(tr_lower(title) LIKE ? OR tr_lower(content) LIKE ?)'
        : '(title LIKE ? OR content LIKE ?)',
    )
    .join(' OR ');
  conditions.push(`(${likeClauses})`);
  for (const t of tokens) {
    params.push(`%${t}%`, `%${t}%`);
  }

  const limit = options?.limit ?? 50;
  const sql = `SELECT id, title, content, importance_score FROM memories WHERE ${conditions.join(' AND ')} LIMIT ${limit}`;

  try {
    return adapter.queryAll<MemoryRow>(sql, params);
  } catch {
    return [];
  }
}

export const opencodeMemoryPlugin: OpenCodePlugin = async (
  input: PluginInput,
): Promise<OpenCodeHooks> => {
  let adapter: DatabaseAdapter | null = null;
  let dbInitError: string | null = null;
  let adapterEngineName: string = 'none';

  const cwd = input.directory || process.cwd();
  if (!process.env.MCP_MEMORY_CONFIG_PATH && existsSync(join(cwd, '.mcp-memory', 'config.json'))) {
    process.env.MCP_MEMORY_CONFIG_PATH = join(cwd, '.mcp-memory', 'config.json');
  }

  const isRemote = isRemoteConfigured(cwd);
  const remoteEndpoint = isRemote ? getRemoteEndpoint(cwd) : null;

  const initAdapter = async (): Promise<DatabaseAdapter | null> => {
    if (isRemote) {
      if (remoteEndpoint?.url) {
        adapter = createRemoteDatabaseAdapter(remoteEndpoint.url, remoteEndpoint.token);
        adapterEngineName = adapter.engine;
        dbInitError = null;
        return adapter;
      }
      adapter = createNoopDatabaseAdapter();
      adapterEngineName = adapter.engine;
      dbInitError = null;
      return adapter;
    }

    try {
      const dbPath = resolveDbPath();
      if (!existsSync(dbPath)) {
        if (process.env.MCP_MEMORY_DB_PATH) {
          dbInitError = `dbPath not found: ${dbPath}`;
          return null;
        }
      }
      const created = await createDatabaseAdapter(dbPath, { isRemote: false });
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

        if (activeAdapter.engine === 'remote-noop') {
          output.system.push('Memory server: connected (remote mode)');
          logBridge('system.transform', { isRemote: true, mode: 'remote-noop' });
          return;
        }

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
                   AND scope != 'user'
                   AND (namespace = ? OR namespace IS NULL OR namespace = '')
                   AND (content LIKE ? OR title LIKE ?) ORDER BY importance_score DESC LIMIT 2`,
                  [namespace, `%${part}%`, `%${part}%`],
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
            `SELECT COUNT(*) as cnt FROM memories
             WHERE parent_id IS NULL AND superseded_at IS NULL
               AND valid_to IS NULL AND tx_expired IS NULL
               AND scope != 'user'
               AND (namespace = ? OR namespace IS NULL OR namespace = '')`,
            [namespace],
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
             AND scope != 'user'
             AND (namespace = ? OR namespace IS NULL OR namespace = '')
             ORDER BY (namespace = ?) DESC, importance_score DESC LIMIT 3`,
            [namespace, namespace],
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
                AND scope != 'user'
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

        summaryBlock += `\n--- memory persistence directive ---\n${MEMORY_PERSISTENCE_DIRECTIVE}\n`;

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
        if (!shouldRecall(tokens) || activeAdapter.engine === 'noop' || activeAdapter.engine === 'remote-noop') {
          return;
        }

        const cwd = input.directory || process.cwd();
        let namespace: string;
        try {
          namespace = resolveNamespace(cwd);
        } catch {
          namespace = basename(cwd) || '';
        }

        const mutedIds = getSessionMutedMemoryIds(sessionID);

        const rows = searchMemoriesLightweight(activeAdapter, tokens, {
          namespace,
        });

        // Filter out any memories that the user explicitly muted for this session in the sidebar
        const eligibleRows = mutedIds.size > 0 ? rows.filter((r) => !mutedIds.has(r.id)) : rows;

        let ranked: ScoredMemoryRow[] = rankMemories(eligibleRows, tokens, 5);

        // Optional two-stage GPU reranking if mcp-memory-reranker service is active
        try {
          const localRerankUrl = process.env.MCP_MEMORY_RERANKER_URL || 'http://127.0.0.1:8765/rerank';
          if (ranked.length > 0) {
            const resp = await fetch(localRerankUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                query: fullPrompt,
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
                  if (item.logit > -5.0 && item.score > 0.005) {
                    orig.similarity = item.score;
                    reranked.push(orig);
                  }
                }
                ranked = reranked.slice(0, 3);
              }
            }
          }
        } catch {
          // Graceful fallback to keyword rank if reranker is not reachable
        }

        const recallBlock = formatRecall(ranked.slice(0, 3));
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
