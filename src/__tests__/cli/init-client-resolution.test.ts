import { describe, it, expect } from 'vitest';
import { detectClient, resolveClient } from '../../cli/init.js';
import { parseInitFlags } from '../../cli/init-flags.js';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('detectClient', () => {
  it('detects opencode when OPENCODE=1 in env', () => {
    expect(detectClient({ env: { OPENCODE: '1' } })).toBe('opencode');
  });

  it('detects opencode when OPENCODE_PID is set in env', () => {
    expect(detectClient({ env: { OPENCODE_PID: '12345' } })).toBe('opencode');
  });

  it('detects opencode when ~/.config/opencode exists and ~/.claude does not', () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'client-detect-'));
    try {
      mkdirSync(join(tempHome, '.config', 'opencode'), { recursive: true });
      expect(detectClient({ env: {}, homeDir: tempHome })).toBe('opencode');
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('detects claude when ~/.claude exists', () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'client-detect-'));
    try {
      mkdirSync(join(tempHome, '.claude'), { recursive: true });
      expect(detectClient({ env: {}, homeDir: tempHome })).toBe('claude');
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('defaults to claude when neither config exists and env is empty', () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'client-detect-'));
    try {
      expect(detectClient({ env: {}, homeDir: tempHome })).toBe('claude');
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe('resolveClient', () => {
  it('explicit --client opencode → opencode', () => {
    expect(resolveClient(['node', 'init', '--client', 'opencode'])).toBe('opencode');
  });

  it('explicit --client claude → claude', () => {
    expect(resolveClient(['node', 'init', '--client', 'claude'])).toBe('claude');
  });

  it('supports --client=opencode format', () => {
    expect(resolveClient(['node', 'init', '--client=opencode'])).toBe('opencode');
  });

  it('supports --client=claude format', () => {
    expect(resolveClient(['node', 'init', '--client=claude'])).toBe('claude');
  });
});

describe('parseInitFlags --client support', () => {
  it('captures --client flag', () => {
    expect(parseInitFlags(['init', '--client', 'opencode']).client).toBe('opencode');
    expect(parseInitFlags(['init', '--client=claude']).client).toBe('claude');
  });

  it('omits client field when not provided', () => {
    const flags = parseInitFlags(['init']);
    expect(flags.client).toBeUndefined();
    expect(flags).toEqual({ installSkill: true, registerServer: true });
  });
});
