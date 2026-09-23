/**
 * Regression coverage for the SessionEnd hook's transcript_path validation.
 *
 * Restricts transcript_path to ~/.claude/projects (override via MCP_MEMORY_TRANSCRIPT_BASE).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTranscriptPath, writePendingJob } from '../../hooks/memory-session-end.js';
import { readFileSync } from 'node:fs';

let tmpRoot: string;
let allowed: string;
let outsidePath: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'mcp-session-end-test-'));
  allowed = join(tmpRoot, 'allowed');
  mkdirSync(allowed, { recursive: true });
  process.env.MCP_MEMORY_TRANSCRIPT_BASE = allowed;

  // A real file inside the allowed base
  writeFileSync(join(allowed, 'session-abc.jsonl'), '{}\n');

  // A real file outside the allowed base
  outsidePath = join(tmpRoot, 'outside.jsonl');
  writeFileSync(outsidePath, '{}\n');
});

afterEach(() => {
  delete process.env.MCP_MEMORY_TRANSCRIPT_BASE;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('resolveTranscriptPath for memory-session-end', () => {
  it('accepts a path inside the allowed base', () => {
    const result = resolveTranscriptPath(join(allowed, 'session-abc.jsonl'));
    expect(result).toBe(join(allowed, 'session-abc.jsonl'));
  });

  it('rejects /etc/passwd-style paths outside the allowed base', () => {
    expect(resolveTranscriptPath('/etc/passwd')).toBeNull();
  });

  it('rejects a real but out-of-base file', () => {
    expect(resolveTranscriptPath(outsidePath)).toBeNull();
  });

  it('rejects path traversal attempts', () => {
    const traversal = join(allowed, '..', 'outside.jsonl');
    expect(resolveTranscriptPath(traversal)).toBeNull();
  });

  it('rejects null bytes', () => {
    expect(resolveTranscriptPath(join(allowed, 'session.jsonl') + '\x00.txt')).toBeNull();
  });

  it('rejects non-string inputs', () => {
    expect(resolveTranscriptPath(undefined)).toBeNull();
    expect(resolveTranscriptPath(123)).toBeNull();
    expect(resolveTranscriptPath({})).toBeNull();
    expect(resolveTranscriptPath('')).toBeNull();
  });

  it('rejects paths that do not exist (mustExist)', () => {
    expect(resolveTranscriptPath(join(allowed, 'no-such-file.jsonl'))).toBeNull();
  });

  it('writePendingJob records pid and attempts correctly', () => {
    const pendingDir = join(tmpRoot, 'pending');
    const sessionId = 'test-session-456';
    const transcript = join(allowed, 'session-abc.jsonl');
    const cwd = '/test/cwd';

    // Successful spawn case
    const filePathSuccess = writePendingJob(pendingDir, sessionId, transcript, cwd, 99999, 1);
    const contentSuccess = JSON.parse(readFileSync(filePathSuccess, 'utf-8'));
    expect(contentSuccess.pid).toBe(99999);
    expect(contentSuccess.attempts).toBe(1);
    expect(contentSuccess.sessionId).toBe(sessionId);
    expect(contentSuccess.cwd).toBe(cwd);

    // Failed spawn case
    const filePathFail = writePendingJob(pendingDir, sessionId, transcript, cwd, null, 0);
    const contentFail = JSON.parse(readFileSync(filePathFail, 'utf-8'));
    expect(contentFail.pid).toBeNull();
    expect(contentFail.attempts).toBe(0);
  });
});
