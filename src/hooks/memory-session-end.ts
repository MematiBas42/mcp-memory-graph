#!/usr/bin/env node
// Claude Code SessionEnd hook — review session via headless `claude -p` on session exit (/exit or Ctrl+D)
// and let Claude store key findings. Triggers only once at true session end.

import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sanitizePath } from '../lib/path-validation.js';

function isDebugLogEnabled(): boolean {
  try {
    const configPath = process.env.MCP_MEMORY_CONFIG_PATH || join(homedir(), '.mcp-memory', 'config.json');
    if (!existsSync(configPath)) return false;
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    return config.hooks?.debug_log === true;
  } catch {
    return false;
  }
}

function logHook(msg: string): void {
  if (!isDebugLogEnabled()) return;
  try {
    const logDir = join(homedir(), '.mcp-memory', 'logs');
    mkdirSync(logDir, { recursive: true });
    appendFileSync(join(logDir, 'hooks.log'), `[${new Date().toISOString()}] [SessionEnd] ${msg}\n`);
  } catch {
    // best-effort
  }
}

/**
 * Restricts the transcript_path supplied by the hook payload to a project-
 * controlled directory. Default base: `~/.claude/projects` (Claude Code's
 * transcript root). Override with MCP_MEMORY_TRANSCRIPT_BASE for tests or
 * non-default Claude Code installs.
 *
 * Returns null on any rejection — caller should exit silently with code 0.
 */
export function resolveTranscriptPath(rawPath: unknown): string | null {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return null;
  const allowedBase = process.env.MCP_MEMORY_TRANSCRIPT_BASE
    ?? join(homedir(), '.claude', 'projects');
  return sanitizePath(rawPath, { mustExist: true, allowedBase });
}

async function main(): Promise<void> {
  // Re-entry guard: when this hook spawns a headless `claude -p`, that session
  // will also fire a SessionEnd hook on its own exit. Without this, infinite recursion.
  if (process.env.MCP_MEMORY_REVIEW_IN_PROGRESS === '1') {
    logHook('Ignored due to MCP_MEMORY_REVIEW_IN_PROGRESS=1');
    process.exit(0);
  }

  const stdinTimeout = setTimeout(() => {
    logHook('Stdin read timed out after 5000ms');
    process.exit(0);
  }, 5000);
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  clearTimeout(stdinTimeout);

  let input: Record<string, unknown> | null = null;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString());
  } catch (e) {
    logHook(`Failed to parse stdin JSON: ${e}`);
    process.exit(0);
  }

  const sessionId = typeof input?.session_id === 'string' ? input.session_id : '';
  const reason = typeof input?.reason === 'string' ? input.reason : 'unknown';
  logHook(`Fired for session=${sessionId} reason=${reason}`);

  const configPath = process.env.MCP_MEMORY_CONFIG_PATH || join(homedir(), '.mcp-memory', 'config.json');
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    if (config.hooks?.review_on_session_end === false || config.hooks?.review_on_stop === false) {
      logHook('Disabled via config (review_on_session_end=false)');
      process.exit(0);
    }
  } catch {
    // No config or unreadable — default behaviour is enabled.
  }

  const transcriptPath = resolveTranscriptPath(input?.transcript_path);
  if (!transcriptPath) {
    logHook(`Invalid or missing transcript_path: ${input?.transcript_path}`);
    process.exit(0);
  }

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const reviewScript = join(__dirname, '..', 'cli', 'review-and-store.js');
  if (!existsSync(reviewScript)) {
    logHook(`Review script not found at ${reviewScript}`);
    process.exit(0);
  }

  // Register pending review job so shutdown guards hold the machine even if terminal/process is killed
  const pendingDir = join(homedir(), '.mcp-memory', 'pending');
  const safeSessionId = sessionId || `${Date.now()}`;
  const pendingFile = join(pendingDir, `${safeSessionId}.json`);
  const cwdVal = (input?.cwd as string) || process.cwd();

  try {
    mkdirSync(pendingDir, { recursive: true });
    writeFileSync(pendingFile, JSON.stringify({
      transcriptPath,
      sessionId: safeSessionId,
      cwd: cwdVal,
      createdAt: new Date().toISOString(),
    }));
    logHook(`Registered pending review: ${pendingFile}`);
  } catch (err) {
    logHook(`Failed to write pending file: ${err}`);
  }

  try {
    const child = spawn('node', [reviewScript, transcriptPath, safeSessionId], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, MCP_MEMORY_CWD: cwdVal },
    });
    child.unref();
    logHook(`Spawned detached reviewer pid=${child.pid} for session=${safeSessionId}`);
  } catch (err) {
    logHook(`Failed to spawn reviewer: ${err}`);
    console.error(JSON.stringify({
      event: 'session_end_hook_spawn_failed',
      err: err instanceof Error ? err.message : String(err),
    }));
    process.exit(0);
  }
}

// Allow tests to import `resolveTranscriptPath` without invoking main().
const isMain = (() => {
  try {
    if (!process.argv[1]) return false;
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return process.argv[1] === fileURLToPath(import.meta.url);
  }
})();
if (isMain) {
  main().catch(() => process.exit(0));
}
