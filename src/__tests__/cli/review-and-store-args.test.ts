/**
 * Regression coverage for the Stop-hook reviewer's MCP wiring.
 *
 * Pre-fix: review-and-store.ts spawned `claude -p` with only --allowedTools and
 * relied on ambient MCP auto-discovery. The memory-server (registered as
 * `npx -y mcp-memory-graph`) intermittently lost the cold-start connect race
 * against the lighter servers, so the reviewer fell back to file memory and
 * never wrote lessons to the graph. It also failed deterministically from any
 * project where memory-server wasn't registered (e.g. a subdir cwd).
 *
 * Post-fix: buildReviewerArgs pins a single, self-described server launched with
 * the current node binary and passes --strict-mcp-config, so the reviewer loads
 * exactly that one server, fast and regardless of cwd.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  buildReviewerArgs,
  resolveServerEntry,
  cleanupPendingFile,
  extractUserInteraction,
  shouldSkipReview,
} from '../../cli/review-and-store.js';

describe('buildReviewerArgs', () => {
  const entry = '/some/install/dist/index.js';

  it('passes --strict-mcp-config so ambient project/user MCP config is ignored', () => {
    const { args } = buildReviewerArgs(entry);
    expect(args).toContain('--strict-mcp-config');
  });

  it('pins exactly the memory-server, launched with the current node binary', () => {
    const { args, mcpConfig } = buildReviewerArgs(entry);
    const i = args.indexOf('--mcp-config');
    expect(i).toBeGreaterThanOrEqual(0);
    // the JSON config is the argv element right after the flag
    expect(args[i + 1]).toBe(mcpConfig);

    const cfg = JSON.parse(mcpConfig);
    expect(Object.keys(cfg.mcpServers)).toEqual(['memory-server']);
    expect(cfg.mcpServers['memory-server']).toMatchObject({
      type: 'stdio',
      command: process.execPath,
      args: [entry],
    });
  });

  it('restricts the reviewer to the four memory tools', () => {
    const { args } = buildReviewerArgs(entry);
    const i = args.indexOf('--allowedTools');
    expect(i).toBeGreaterThanOrEqual(0);
    const tools = args[i + 1].split(',');
    expect(tools).toEqual([
      'mcp__memory-server__memory_search',
      'mcp__memory-server__memory_store',
      'mcp__memory-server__memory_lesson',
      'mcp__memory-server__memory_reflect',
    ]);
  });

  it('runs headless with text output', () => {
    const { args } = buildReviewerArgs(entry);
    expect(args[0]).toBe('-p');
    expect(args).toContain('--output-format');
    expect(args[args.indexOf('--output-format') + 1]).toBe('text');
  });

  it('resolves the server entry to this package dist/index.js', () => {
    // dist/cli/review-and-store.js -> dist/index.js (portable, no hardcoded path)
    expect(resolveServerEntry().replace(/\\/g, '/')).toMatch(/\/index\.js$/);
    expect(resolveServerEntry()).not.toContain('npx');
  });

  it('cleanupPendingFile removes the session pending file if it exists', () => {
    const testSession = 'test-session-cleanup-123';
    const pendingDir = join(homedir(), '.mcp-memory', 'pending');
    mkdirSync(pendingDir, { recursive: true });
    const targetFile = join(pendingDir, `${testSession}.json`);
    writeFileSync(targetFile, JSON.stringify({ test: true }));
    expect(existsSync(targetFile)).toBe(true);

    cleanupPendingFile(testSession);
    expect(existsSync(targetFile)).toBe(false);
  });

  it('extractUserInteraction correctly counts user messages and extracts lastUserUuid', () => {
    const emptyJsonl = '{"type":"mode"}\n{"type":"cost-state"}\n';
    expect(extractUserInteraction(emptyJsonl)).toEqual({
      userMessageCount: 0,
      lastUserUuid: null,
      hasAssistantResponse: false,
    });

    const clearOnlyJsonl = [
      '{"type":"mode"}',
      '{"type":"user","message":{"content":"<local-command-caveat>Caveat: ...</local-command-caveat>"}}',
      '{"type":"user","message":{"content":"<command-name>/clear</command-name>\\n<command-message>clear</command-message>"}}',
      '{"type":"system","subtype":"local_command"}',
    ].join('\n');
    expect(extractUserInteraction(clearOnlyJsonl)).toEqual({
      userMessageCount: 0,
      lastUserUuid: null,
      hasAssistantResponse: false,
    });

    const parameterizedCommandJsonl = [
      '{"type":"mode"}',
      '{"type":"user","uuid":"u-wf","message":{"content":"<command-name>/workflow-authoring</command-name>\\n<command-args>Plan multi-agent review</command-args>"}}',
      '{"type":"assistant","message":{"content":"I will plan the workflow..."}}',
    ].join('\n');
    expect(extractUserInteraction(parameterizedCommandJsonl)).toEqual({
      userMessageCount: 1,
      lastUserUuid: 'u-wf',
      hasAssistantResponse: true,
    });

    const activeJsonl = [
      '{"type":"mode"}',
      '{"type":"user","uuid":"u-1","message":{"content":"hello"}}',
      '{"type":"assistant","message":{"content":"hi"}}',
      '{"type":"user","uuid":"u-2","message":{"content":"how are you?"}}',
      '{"type":"cost-state"}',
    ].join('\n');

    expect(extractUserInteraction(activeJsonl)).toEqual({
      userMessageCount: 2,
      lastUserUuid: 'u-2',
      hasAssistantResponse: true,
    });
  });

  it('shouldSkipReview accurately determines when to skip without new user turns', () => {
    const testMarker = join(homedir(), '.mcp-memory', 'pending', 'test-marker.json');

    // 1. Zero user messages or no assistant response -> always skip
    expect(shouldSkipReview(null, 1000, { userMessageCount: 0, lastUserUuid: null, hasAssistantResponse: false })).toBe(true);
    expect(shouldSkipReview(null, 1000, { userMessageCount: 1, lastUserUuid: 'u-1', hasAssistantResponse: false })).toBe(true);

    // 2. Non-existent marker with valid conversation -> do not skip
    expect(shouldSkipReview('/non/existent/marker.json', 1000, { userMessageCount: 1, lastUserUuid: 'u-1', hasAssistantResponse: true })).toBe(false);

    // 3. Marker with identical lastUserUuid -> skip!
    writeFileSync(testMarker, JSON.stringify({
      reviewedAt: new Date().toISOString(),
      transcriptBytes: 5000,
      userMessageCount: 2,
      lastUserUuid: 'u-2',
    }));
    expect(shouldSkipReview(testMarker, 5200, { userMessageCount: 2, lastUserUuid: 'u-2', hasAssistantResponse: true })).toBe(true);

    // 4. Marker with different lastUserUuid (new user turn) -> do not skip!
    expect(shouldSkipReview(testMarker, 5500, { userMessageCount: 3, lastUserUuid: 'u-3', hasAssistantResponse: true })).toBe(false);

    // 5. Resume cancelled ending -> always skip review even if marker is missing
    const resumeCancelledTranscript = '{"type":"user","uuid":"u-1"}\n{"type":"assistant"}\n<local-command-stdout>Resume cancelled</local-command-stdout>';
    expect(shouldSkipReview(null, 1000, { userMessageCount: 1, lastUserUuid: 'u-1', hasAssistantResponse: true }, undefined, resumeCancelledTranscript)).toBe(true);

    rmSync(testMarker, { force: true });
  });
});
