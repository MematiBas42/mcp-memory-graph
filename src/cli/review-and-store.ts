#!/usr/bin/env node
// Background CLI spawned by the Stop hook. Invokes `claude -p` headless,
// scoped to the memory write/recall tools, so Claude reviews the session
// transcript and persists durable findings as structured lessons, facts,
// and (when warranted) one synthesized reflection. Replaces the broken
// agent-type Stop hook path.

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, unlinkSync, statSync, realpathSync } from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveDbPath } from '../db/db-path.js';
import { resolveReviewPaths } from './review-paths.js';

const REVIEW_INSTRUCTIONS = `Review this session and persist only durable, reusable PROJECT knowledge that will help future sessions. Be selective: at most ~5 writes total, and if nothing significant happened, write nothing.

Route each finding to the right tool:
- A lesson, incident, or bug-fix — something that went wrong (or a non-obvious gotcha) plus WHY and HOW to avoid/fix it — use memory_lesson. Set document_type to "lesson", "incident", or "bug-fix" and fill the matching fields (lesson: what, why_it_matters, how_to_apply; incident/bug-fix: symptom, root_cause, fix, prevention).
- A plain fact, decision, pattern, or convention — use memory_store. ALWAYS pass the structured \`title\` argument (max 80 chars) as its own tool parameter, NOT a "Title:" line inside the content body.

Avoid duplicates: before writing a fact, call memory_search to check whether it already exists. If your finding refines or corrects an existing memory, write with on_conflict: "supersede" (or "update") instead of adding a near-duplicate.

If two or more of your findings share a higher-level theme, make ONE memory_reflect call — mode "gather" to pull the material, then mode "store" with the synthesized insight and the source_ids of the memories you just wrote. At most one reflection per session.

Scope every write to "project" with a namespace derived from the repo/project. Store only genuinely useful knowledge — never code snippets, tool meta-commentary, or fragments.`;

const MIN_TRANSCRIPT_CHARS = 500;
const MAX_TRANSCRIPT_BYTES = 200_000;

export interface UserInteractionInfo {
  userMessageCount: number;
  lastUserUuid: string | null;
  hasAssistantResponse: boolean;
}

const UI_ONLY_COMMANDS = new Set([
  'clear',
  'exit',
  'resume',
  'color',
  'theme',
  'statusline',
  'terminal-setup',
  'radio',
  'cost',
]);

export function isMeaningfulUserContent(content: unknown): boolean {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (!trimmed) return false;
    if (trimmed.includes('<local-command-caveat>')) return false;
    if (trimmed.includes('Resume cancelled')) return false;

    // Check if it is a slash command
    if (trimmed.includes('<command-name>')) {
      const nameMatch = trimmed.match(/<command-name>\/?(.*?)<\/command-name>/);
      const cmdName = nameMatch ? nameMatch[1].trim().toLowerCase() : '';
      const argsMatch = trimmed.match(/<command-args>([\s\S]*?)<\/command-args>/);
      const cmdArgs = argsMatch ? argsMatch[1].trim() : '';

      // If command has meaningful arguments/prompt, it is a real task
      if (cmdArgs.length > 0) return true;

      // Pure command without args: if it is in UI-only blacklist, it's not meaningful
      if (UI_ONLY_COMMANDS.has(cmdName)) return false;

      // Skill invocations without explicit args (like /init, /workflow-authoring)
      return true;
    }

    // Bare text commands like "clear", "exit", "resume"
    const lower = trimmed.toLowerCase();
    if (lower === 'clear' || lower === 'exit' || lower === 'resume') return false;
    if (lower.startsWith('/')) {
      const bareCmd = lower.slice(1).split(/\s+/)[0];
      const rest = lower.slice(1 + bareCmd.length).trim();
      if (rest.length > 0) return true;
      if (UI_ONLY_COMMANDS.has(bareCmd)) return false;
    }

    return true;
  }
  if (Array.isArray(content)) {
    return content.some((block) => {
      if (typeof block === 'string') return isMeaningfulUserContent(block);
      if (block && typeof block === 'object' && block.type === 'text') {
        return isMeaningfulUserContent(block.text);
      }
      return false;
    });
  }
  return false;
}

export function hasResumeCancelledEnding(content: string): boolean {
  // Check the tail of the transcript (last ~3000 bytes) for an aborted resume
  const tail = content.length > 3000 ? content.slice(-3000) : content;
  return tail.includes('Resume cancelled');
}

export function extractUserInteraction(content: string): UserInteractionInfo {
  let userMessageCount = 0;
  let lastUserUuid: string | null = null;
  let hasAssistantResponse = false;
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('"type":"assistant"') || line.includes('"role":"assistant"')) {
      hasAssistantResponse = true;
    }
    if (!line.includes('"type":"user"')) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'user') {
        const rawContent = obj.message?.content ?? obj.content;
        if (isMeaningfulUserContent(rawContent)) {
          userMessageCount++;
          if (typeof obj.uuid === 'string' && obj.uuid.length > 0) {
            lastUserUuid = obj.uuid;
          }
        }
      }
    } catch {
      // ignore malformed lines
    }
  }
  return { userMessageCount, lastUserUuid, hasAssistantResponse };
}

export function hasUserInteraction(content: string): boolean {
  const info = extractUserInteraction(content);
  return info.userMessageCount > 0 && info.hasAssistantResponse;
}

export function shouldSkipReview(
  markerPath: string | null,
  currentBytes: number,
  interaction: UserInteractionInfo,
  transcriptPath?: string,
  rawContent?: string,
): boolean {
  // 1. If there are no meaningful user messages OR assistant never responded, skip
  if (interaction.userMessageCount === 0 || !interaction.hasAssistantResponse) {
    return true;
  }

  // 2. If the last action was an aborted resume ("Resume cancelled"), skip review
  if (rawContent && hasResumeCancelledEnding(rawContent)) {
    return true;
  }

  // 2. If no marker exists, cannot skip
  if (!markerPath || !existsSync(markerPath)) {
    return false;
  }

  try {
    const raw = readFileSync(markerPath, 'utf-8').trim();
    if (raw.startsWith('{')) {
      const data = JSON.parse(raw);
      // If marker recorded lastUserUuid, match means exact same conversation end
      if (data.lastUserUuid && interaction.lastUserUuid) {
        return data.lastUserUuid === interaction.lastUserUuid;
      }
      // If marker recorded userMessageCount
      if (typeof data.userMessageCount === 'number') {
        return interaction.userMessageCount <= data.userMessageCount;
      }
      // Backwards-compat for early JSON markers: if transcript did not grow by > 4KB,
      // it was just Claude Code metadata appends (cost-state, mode, etc.)
      if (typeof data.transcriptBytes === 'number') {
        return currentBytes <= data.transcriptBytes + 4096;
      }
    } else {
      // Legacy marker (pre-JSON timestamp): if marker exists, session was already reviewed.
      // Skip unless transcript has substantially grown after marker.
      const markerStat = statSync(markerPath);
      if (transcriptPath && existsSync(transcriptPath)) {
        const transcriptStat = statSync(transcriptPath);
        if (transcriptStat.mtimeMs <= markerStat.mtimeMs + 5000) {
          return true;
        }
      }
      return true;
    }
  } catch {
    return true;
  }

  return false;
}
const HARD_TIMEOUT_MS = 5 * 60 * 1000;

// The only tools the reviewer is ever allowed to call.
const ALLOWED_TOOLS = [
  'mcp__memory-server__memory_search',
  'mcp__memory-server__memory_store',
  'mcp__memory-server__memory_lesson',
  'mcp__memory-server__memory_reflect',
].join(',');

/**
 * Path to this package's compiled MCP server entry (`dist/index.js`), resolved
 * relative to this file (`dist/cli/review-and-store.js`) so it is portable
 * across install locations — no hardcoded npm path, no `npx` resolve.
 */
export function resolveServerEntry(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'index.js');
}

/**
 * Build the argv for the headless `claude -p` reviewer. We pin it to a single,
 * self-described MCP server (this package, launched with the current node
 * binary) and pass `--strict-mcp-config` so Claude ignores the user's ambient
 * project/user MCP config entirely. That removes the `npx`-cold-start connect
 * race (the reviewer no longer competes with ~6 other servers booting at once)
 * AND makes the reviewer cwd-independent, so it works from any project — not
 * just the one where `memory-server` happens to be registered.
 */
export function buildReviewerArgs(
  serverEntry: string,
  allowedTools: string = ALLOWED_TOOLS,
): { args: string[]; mcpConfig: string } {
  const mcpConfig = JSON.stringify({
    mcpServers: {
      'memory-server': { type: 'stdio', command: process.execPath, args: [serverEntry], env: {} },
    },
  });
  const args = [
    '-p',
    '--no-session-persistence',
    '--model',
    'sonnet',
    '--strict-mcp-config',
    '--mcp-config',
    mcpConfig,
    '--allowedTools',
    allowedTools,
    '--output-format',
    'text',
  ];
  return { args, mcpConfig };
}

export function cleanupPendingFile(sessionId?: string): void {
  try {
    const id = sessionId || process.argv[3];
    if (id) {
      const pendingFile = join(homedir(), '.mcp-memory', 'pending', `${id}.json`);
      if (existsSync(pendingFile)) {
        unlinkSync(pendingFile);
      }
    }
  } catch {
    // best-effort
  }
}

async function main(): Promise<void> {
  setTimeout(() => process.exit(1), HARD_TIMEOUT_MS);

  const [transcriptPath, sessionId] = process.argv.slice(2);
  if (!transcriptPath) {
    cleanupPendingFile(sessionId);
    process.exit(1);
  }

  let transcript: string;
  try {
    transcript = readFileSync(transcriptPath, 'utf-8');
  } catch {
    cleanupPendingFile(sessionId);
    process.exit(0);
  }

  const interaction = extractUserInteraction(transcript);
  if (transcript.length < MIN_TRANSCRIPT_CHARS || interaction.userMessageCount === 0 || !interaction.hasAssistantResponse) {
    cleanupPendingFile(sessionId);
    process.exit(0);
  }

  let trimmed = transcript;
  if (Buffer.byteLength(trimmed) > MAX_TRANSCRIPT_BYTES) {
    trimmed = trimmed.slice(-MAX_TRANSCRIPT_BYTES);
    trimmed = `[…earlier content truncated…]\n${trimmed}`;
  }

  const sourceTag = sessionId ? `session-${sessionId}` : `stop-${new Date().toISOString()}`;
  const prompt = `${REVIEW_INSTRUCTIONS}\n\nOn every write (memory_store / memory_lesson / memory_reflect), set source to "${sourceTag}".\n\n<transcript>\n${trimmed}\n</transcript>`;

  // Logs + the per-session re-run marker live next to the DB (~/.mcp-memory/logs),
  // so a silently-failed review is observable and a re-fired Stop hook doesn't
  // re-review the same session and write duplicate memories.
  const { logDir, logFile, markerPath } = resolveReviewPaths(
    resolveDbPath(),
    sessionId,
    new Date().toISOString(),
  );
  try {
    mkdirSync(logDir, { recursive: true });
  } catch {
    // best-effort; never block the review on a logdir failure
  }

  // #2 re-run guard: don't double-review an unchanged session.
  // If the session was resumed and transcript grew with new user turns, allow reviewing new content.
  const currentTranscriptBytes = Buffer.byteLength(transcript);
  if (shouldSkipReview(markerPath, currentTranscriptBytes, interaction, transcriptPath, transcript)) {
    cleanupPendingFile(sessionId);
    process.exit(0);
  }
  const logLine = (msg: string): void => {
    try {
      appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
    } catch {
      // logging is best-effort
    }
  };

  // #1 observability: capture the headless review's stdout+stderr to a file so
  // "ran clean" is distinguishable from "never ran" (mirrors the 2.6.3
  // StandardOutPath plist fix). Falls back to 'ignore' if the log can't open.
  let childOut: number | 'ignore' = 'ignore';
  try {
    childOut = openSync(logFile, 'a');
  } catch {
    childOut = 'ignore';
  }
  logLine(`review start (source=${sourceTag}, transcript=${Buffer.byteLength(trimmed)}B)`);

  const claudeBin = process.env.CLAUDE_BIN ?? 'claude';

  const { args } = buildReviewerArgs(resolveServerEntry());

  const child = spawn(
    claudeBin,
    args,
    {
      cwd: process.env.MCP_MEMORY_CWD ?? process.cwd(),
      stdio: ['pipe', childOut, childOut],
      // MCP_TIMEOUT: give the pinned server generous headroom to connect within
      // the reviewer's single turn (default Claude Code startup window is short).
      env: {
        ...process.env,
        MCP_MEMORY_REVIEW_IN_PROGRESS: '1',
        MCP_TIMEOUT: process.env.MCP_TIMEOUT ?? '30000',
      },
    },
  );

  const finish = (code: number): void => {
    logLine(`review end (exit=${code})`);

    // Sistem bildirimi (Arch Linux & macOS uyumlu)
    try {
      const msg = code === 0
        ? 'Oturum sonu hafıza analizi tamamlandı.'
        : `Oturum sonu hafıza analizi tamamlanamadı (kod: ${code}). Günlük: ~/.mcp-memory/logs/`;
      if (process.platform === 'linux') {
        execSync(`notify-send "Claude Code" "${msg}" -a "MCP Memory" -i "$HOME/.mcp-memory/claude-icon.svg"`);
      } else if (process.platform === 'darwin') {
        execSync(`osascript -e 'display notification "${msg}" with title "Claude Code"'`);
      }
    } catch {
      // Bildirim daemon'u yoksa sessizce devam et
    }

    // Mark the session reviewed with user turn identifiers so future resumes without user activity are skipped.
    if (code === 0 && markerPath) {
      try {
        writeFileSync(
          markerPath,
          JSON.stringify({
            reviewedAt: new Date().toISOString(),
            transcriptBytes: currentTranscriptBytes,
            userMessageCount: interaction.userMessageCount,
            lastUserUuid: interaction.lastUserUuid,
          })
        );
      } catch {
        // best-effort
      }
    }

    // Clean up pending review queue entry
    cleanupPendingFile(sessionId);

    if (typeof childOut === 'number') {
      try {
        closeSync(childOut);
      } catch {
        // already closed
      }
    }
    process.exit(0);
  };

  child.on('error', () => finish(-1));
  child.on('exit', (code) => finish(code ?? 0));

  child.stdin!.on('error', () => {}); // EPIPE (erken kapanma) hatalarını yoksay
  child.stdin!.write(prompt);
  child.stdin!.end();
}

// Only run when invoked as the entry script — keeps the module import-safe so
// the pure helpers above (buildReviewerArgs/resolveServerEntry) can be unit-tested.
const isMain = (() => {
  try {
    if (!process.argv[1]) return false;
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return process.argv[1] === fileURLToPath(import.meta.url);
  }
})();
if (isMain) {
  process.on('SIGTERM', () => {
    cleanupPendingFile();
    process.exit(143);
  });

  process.on('SIGINT', () => {
    cleanupPendingFile();
    process.exit(130);
  });

  process.on('uncaughtException', (err) => {
    try {
      console.error('Uncaught exception in review-and-store:', err);
    } catch {
      // ignore
    }
    cleanupPendingFile();
    process.exit(0);
  });

  process.on('unhandledRejection', (reason) => {
    try {
      console.error('Unhandled rejection in review-and-store:', reason);
    } catch {
      // ignore
    }
    cleanupPendingFile();
    process.exit(0);
  });

  main().catch((err) => {
    try {
      console.error('Main error in review-and-store:', err);
    } catch {
      // ignore
    }
    cleanupPendingFile();
    process.exit(0);
  });
}
