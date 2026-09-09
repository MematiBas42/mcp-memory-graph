import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CrossEncoderReranker } from '../../search/reranker.js';

type RerankerInternals = { tokenizer: unknown; model: unknown; ready: boolean };
type LoaderSlot = { loadModel: (this: RerankerInternals) => Promise<void> };

function loadFakeRerankerModel(target: RerankerInternals): void {
  target.tokenizer = async () => ({});
  target.model = async () => ({ logits: { data: new Float32Array([1.75]) } });
  target.ready = true;
}

const DOCS = [
  { id: 'doc-1', text: 'first document' },
  { id: 'doc-2', text: 'second document' },
];

describe('CrossEncoderReranker HTTP GPU path & Fallback', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('uses HTTP GPU reranker when service returns 200 OK', async () => {
    const fakeResults = [
      { index: 0, score: 0.95, logit: 3.2 },
      { index: 1, score: 0.12, logit: -2.1 },
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: fakeResults }),
    } as Response);

    const reranker = new CrossEncoderReranker('Xenova/bge-reranker-base');
    const res = await reranker.rerank('query', DOCS);

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(res).toEqual([
      { id: 'doc-1', score: 3.2 },
      { id: 'doc-2', score: -2.1 },
    ]);
  });

  it('falls back to local ONNX when HTTP returns 500 error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ detail: 'CUDA out of memory' }),
    } as Response);

    const reranker = new CrossEncoderReranker('Xenova/bge-reranker-base');
    let fallbackLoaded = false;
    (reranker as unknown as LoaderSlot).loadModel = async function (this: RerankerInternals) {
      fallbackLoaded = true;
      loadFakeRerankerModel(this);
    };

    const res = await reranker.rerank('query', DOCS);

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(fallbackLoaded).toBe(true);
    expect(res).toEqual([
      { id: 'doc-1', score: 1.75 },
      { id: 'doc-2', score: 1.75 },
    ]);
  });

  it('falls back to local ONNX when HTTP fetch throws network error or timeout', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('fetch failed: ECONNREFUSED'));

    const reranker = new CrossEncoderReranker('Xenova/bge-reranker-base');
    let fallbackLoaded = false;
    (reranker as unknown as LoaderSlot).loadModel = async function (this: RerankerInternals) {
      fallbackLoaded = true;
      loadFakeRerankerModel(this);
    };

    const res = await reranker.rerank('query', DOCS);

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(fallbackLoaded).toBe(true);
    expect(res).toHaveLength(2);
  });
});
