import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { unlinkSync, existsSync } from 'node:fs';
import { opencodeMemoryPlugin, createDatabaseAdapter } from '../../opencode/plugin.js';
import { createDatabase } from '../../db/connection.js';
import { initializeSchema } from '../../db/schema.js';
import type {
  SystemTransformOutput,
  ChatMessageOutput,
  ToolExecuteAfterInput,
  ToolExecuteAfterOutput,
  CompactingOutput,
} from '../../opencode/types.js';

describe('OpenCode Memory Plugin', () => {
  let tempDbPath: string;
  let testDb: Database.Database | null = null;

  beforeEach(() => {
    tempDbPath = join(tmpdir(), `test-opencode-memory-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  });

  afterEach(() => {
    if (testDb && testDb.open) {
      testDb.close();
      testDb = null;
    }
    if (existsSync(tempDbPath)) {
      try {
        unlinkSync(tempDbPath);
      } catch {
        // Safe ignore
      }
    }
    delete process.env.MCP_MEMORY_DB_PATH;
  });

  it('initializes hooks safely even when database does not exist', async () => {
    process.env.MCP_MEMORY_DB_PATH = join(tmpdir(), 'non-existent-db.db');

    const plugin = await opencodeMemoryPlugin({
      client: {},
      project: {},
      directory: '/tmp/test-project',
      $: {},
    });

    expect(plugin).toBeDefined();
    expect(typeof plugin['experimental.chat.system.transform']).toBe('function');
    expect(typeof plugin['chat.message']).toBe('function');
    expect(typeof plugin['tool.execute.after']).toBe('function');
    expect(typeof plugin['experimental.session.compacting']).toBe('function');
    expect(typeof plugin.dispose).toBe('function');

    // Running system transform with missing DB should be safe no-op
    const transformOutput: SystemTransformOutput = { system: [] };
    await plugin['experimental.chat.system.transform']!({}, transformOutput);
    expect(transformOutput.system).toHaveLength(0);

    // Running chat.message with missing DB should be safe no-op
    const messageOutput: ChatMessageOutput = {
      parts: [{ type: 'text', text: 'deploy #4821 checkout' }],
    };
    await plugin['chat.message']!({}, messageOutput);
    expect(messageOutput.parts).toHaveLength(1);

    // Calling dispose should not throw
    await expect(plugin.dispose!()).resolves.toBeUndefined();
  });

  it('injects system summary and core memory on experimental.chat.system.transform', async () => {
    process.env.MCP_MEMORY_DB_PATH = tempDbPath;
    testDb = createDatabase(tempDbPath);
    initializeSchema(testDb);

    // Insert test memory
    testDb
      .prepare(
        `INSERT INTO memories (id, scope, namespace, title, content, importance_score, created_at, updated_at, valid_from)
         VALUES ('mem-1', 'project', 'test-ns', 'Checkout Service Guide', 'Deployment details for checkout', 0.9, datetime('now'), datetime('now'), datetime('now'))`,
      )
      .run();

    // Insert core_memory
    testDb
      .prepare(
        `INSERT INTO core_memory (scope, namespace, content, updated_at)
         VALUES ('project', 'test-ns', 'Always run tests before push', datetime('now'))`,
      )
      .run();

    const plugin = await opencodeMemoryPlugin({
      client: {},
      project: {},
      directory: '/tmp/test-ns',
      $: {},
    });

    const output: SystemTransformOutput = { system: [] };
    await plugin['experimental.chat.system.transform']!({}, output);

    expect(output.system.length).toBeGreaterThan(0);
    const combinedSystem = output.system.join('\n');
    expect(combinedSystem).toContain('Memory server: 1 memories');
    expect(combinedSystem).toContain('Checkout Service Guide');
    expect(combinedSystem).toContain('core memory (project/test-ns)');
    expect(combinedSystem).toContain('Always run tests before push');

    await plugin.dispose!();
  });

  it('injects context recall in chat.message when relevant query tokens match', async () => {
    process.env.MCP_MEMORY_DB_PATH = tempDbPath;
    testDb = createDatabase(tempDbPath);
    initializeSchema(testDb);

    testDb
      .prepare(
        `INSERT INTO memories (id, scope, namespace, title, content, importance_score, created_at, updated_at, valid_from)
         VALUES ('mem-rec-1', 'project', 'test-project', 'Payment gateway deployment #4821', 'Instructions for payment webhook deployment', 0.95, datetime('now'), datetime('now'), datetime('now'))`,
      )
      .run();

    const plugin = await opencodeMemoryPlugin({
      client: {},
      project: {},
      directory: '/tmp/test-project',
      $: {},
    });

    const output: ChatMessageOutput = {
      parts: [{ type: 'text', text: 'Please continue the #4821 payment gateway deployment' }],
    };

    await plugin['chat.message']!({}, output);

    expect(output.parts.length).toBe(2);
    expect(output.parts[0].type).toBe('text');
    expect((output.parts[0] as any).synthetic).toBe(true);
    expect(output.parts[0].text).toContain('[Context Recall]');
    expect(output.parts[0].text).toContain('Payment gateway deployment #4821');
    expect(output.parts[1].text).toBe('Please continue the #4821 payment gateway deployment');

    await plugin.dispose!();
  });

  it('ignores trivial prompts in chat.message', async () => {
    process.env.MCP_MEMORY_DB_PATH = tempDbPath;
    testDb = createDatabase(tempDbPath);
    initializeSchema(testDb);

    const plugin = await opencodeMemoryPlugin({
      client: {},
      project: {},
      directory: '/tmp/test-project',
      $: {},
    });

    const output: ChatMessageOutput = {
      parts: [{ type: 'text', text: 'ok thanks' }],
    };

    await plugin['chat.message']!({}, output);
    expect(output.parts).toHaveLength(1);

    await plugin.dispose!();
  });

  it('handles tool.execute.after safely for memory_search outcomes', async () => {
    const plugin = await opencodeMemoryPlugin({
      client: {},
      project: {},
      directory: '/tmp/test-project',
      $: {},
    });

    const toolInput: ToolExecuteAfterInput = { tool: 'memory_search' };
    const toolOutput: ToolExecuteAfterOutput = { output: '[]' };

    await expect(plugin['tool.execute.after']!(toolInput, toolOutput)).resolves.toBeUndefined();
    await expect(
      plugin['tool.execute.after']!(
        { tool: 'mcp-memory/memory_search' },
        { output: 'Error: timeout' },
      ),
    ).resolves.toBeUndefined();

    await plugin.dispose!();
  });

  it('handles experimental.session.compacting safely', async () => {
    const plugin = await opencodeMemoryPlugin({
      client: {},
      project: {},
      directory: '/tmp/test-project',
      $: {},
    });

    const compactingOutput: CompactingOutput = { context: ['short context'] };

    await expect(
      plugin['experimental.session.compacting']!({ transcript: 'too short' }, compactingOutput),
    ).resolves.toBeUndefined();

    await plugin.dispose!();
  });

  describe('Multi-Tier DatabaseAdapter', () => {
    it('creates a database adapter for an existing database file', async () => {
      testDb = createDatabase(tempDbPath);
      initializeSchema(testDb);
      testDb.prepare("INSERT INTO core_memory (scope, namespace, content, updated_at) VALUES ('global', '', 'Test core content', datetime('now'))").run();

      const adapter = await createDatabaseAdapter(tempDbPath);
      expect(adapter).not.toBeNull();
      expect(['bun:sqlite', 'better-sqlite3', 'sqlite3-cli']).toContain(adapter!.engine);

      // queryAll
      const allRows = adapter!.queryAll<{ content: string }>(
        'SELECT content FROM core_memory WHERE scope = ?',
        ['global'],
      );
      expect(allRows).toHaveLength(1);
      expect(allRows[0].content).toBe('Test core content');

      // queryGet
      const getRow = adapter!.queryGet<{ content: string }>(
        'SELECT content FROM core_memory WHERE scope = ?',
        ['global'],
      );
      expect(getRow).toBeDefined();
      expect(getRow?.content).toBe('Test core content');

      // queryGet for non-existent row
      const missingRow = adapter!.queryGet<{ content: string }>(
        'SELECT content FROM core_memory WHERE scope = ?',
        ['nonexistent'],
      );
      expect(missingRow).toBeUndefined();

      adapter!.close();
    });

    it('returns null when database path does not exist', async () => {
      const nonExistent = join(tmpdir(), 'definitely-does-not-exist.db');
      const adapter = await createDatabaseAdapter(nonExistent);
      expect(adapter).toBeNull();
    });
  });
});
