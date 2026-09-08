import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { configuredDimensions, configuredModelName } from '../../db/schema.js';
import { getEmbedder, disposeEmbedder } from '../../lib/direct-access.js';

describe('Ollama embedding provider direct access wiring', () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    delete process.env.MCP_MEMORY_PROVIDER;
    delete process.env.MCP_MEMORY_MODEL;
    delete process.env.MCP_MEMORY_DIMENSIONS;
    delete process.env.OLLAMA_BASE_URL;
  });

  afterEach(async () => {
    await disposeEmbedder();
    process.env = { ...envBackup };
  });

  it('defaults to 768 dimensions when MCP_MEMORY_PROVIDER is ollama', () => {
    process.env.MCP_MEMORY_PROVIDER = 'ollama';
    expect(configuredDimensions()).toBe(768);
  });

  it('respects explicit MCP_MEMORY_DIMENSIONS under ollama provider', () => {
    process.env.MCP_MEMORY_PROVIDER = 'ollama';
    process.env.MCP_MEMORY_DIMENSIONS = '1024';
    expect(configuredDimensions()).toBe(1024);
  });

  it('defaults modelName to nomic-embed-text when MCP_MEMORY_PROVIDER is ollama and MODEL is unset', () => {
    process.env.MCP_MEMORY_PROVIDER = 'ollama';
    expect(configuredModelName()).toBe('nomic-embed-text');
  });

  it('respects explicit MCP_MEMORY_MODEL when provider is ollama', () => {
    process.env.MCP_MEMORY_PROVIDER = 'ollama';
    process.env.MCP_MEMORY_MODEL = 'bge-m3';
    expect(configuredModelName()).toBe('bge-m3');
  });

  it('instantiates an OllamaEmbeddingProvider when MCP_MEMORY_PROVIDER=ollama', async () => {
    process.env.MCP_MEMORY_PROVIDER = 'ollama';
    process.env.MCP_MEMORY_MODEL = 'nomic-embed-text';
    process.env.MCP_MEMORY_DIMENSIONS = '768';
    
    const embedder = await getEmbedder();
    expect(embedder.modelName).toBe('nomic-embed-text');
    expect(embedder.dimensions).toBe(768);
    expect(embedder.isReady()).toBe(true);

    // Verify memoization
    const embedder2 = await getEmbedder();
    expect(embedder2).toBe(embedder);
  });

  it('respects OLLAMA_BASE_URL when instantiating OllamaEmbeddingProvider', async () => {
    process.env.MCP_MEMORY_PROVIDER = 'ollama';
    process.env.OLLAMA_BASE_URL = 'http://192.168.1.100:11434';

    const embedder = await getEmbedder();
    expect(embedder.modelName).toBe('nomic-embed-text');
    expect(embedder.dimensions).toBe(768);
  });
});
