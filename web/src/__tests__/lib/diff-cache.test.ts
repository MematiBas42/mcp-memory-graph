import { describe, it, expect, beforeEach } from "vitest"
import {
  getCachedDiff,
  setCachedDiff,
  clearDiffCache,
  getOrComputeDiff,
  getDiffCacheSize,
  makeDiffCacheKey,
  MAX_DIFF_CACHE_SIZE,
  type DiffResult,
} from "@/lib/diff-cache"

describe("diff-cache (in-memory LRU cache)", () => {
  beforeEach(() => {
    clearDiffCache()
  })

  it("stores and retrieves diff by memoryId and version numbers", () => {
    const mockDiff: DiffResult = {
      summary: { added: 1, removed: 0, unchanged: 2 },
      contentDiff: [
        { type: "ctx", line: "a" },
        { type: "add", line: "b" },
      ],
      metaDiff: [],
      titleChanged: false,
    }

    expect(getCachedDiff("mem1", 1, 2)).toBeUndefined()
    setCachedDiff("mem1", 1, 2, mockDiff)
    expect(getCachedDiff("mem1", 1, 2)).toEqual(mockDiff)
  })

  it("stores and retrieves diff by direct cacheKey string", () => {
    const key = makeDiffCacheKey("mem2", 2, 3)
    const mockDiff: DiffResult = {
      summary: { added: 0, removed: 1, unchanged: 1 },
      contentDiff: [{ type: "del", line: "old" }],
      metaDiff: [],
      titleChanged: true,
    }

    setCachedDiff(key, mockDiff)
    expect(getCachedDiff(key)).toEqual(mockDiff)
    expect(getCachedDiff("mem2", 2, 3)).toEqual(mockDiff)
  })

  it("clears diff cache via clearDiffCache()", () => {
    setCachedDiff("mem1", 1, 2, {
      summary: { added: 1, removed: 0, unchanged: 0 },
      contentDiff: [{ type: "add", line: "x" }],
      metaDiff: [],
      titleChanged: false,
    })
    expect(getDiffCacheSize()).toBe(1)
    clearDiffCache()
    expect(getDiffCacheSize()).toBe(0)
    expect(getCachedDiff("mem1", 1, 2)).toBeUndefined()
  })

  it("computes diff and caches result in getOrComputeDiff", () => {
    const cacheKey = "test-key-1"
    const oldText = "line 1\nline 2"
    const newText = "line 1\nline 2 modified"

    const result1 = getOrComputeDiff(cacheKey, oldText, newText)
    expect(result1.summary.added).toBe(1)
    expect(result1.summary.removed).toBe(1)
    expect(getDiffCacheSize()).toBe(1)

    // Second call should return cached result
    const result2 = getOrComputeDiff(cacheKey, "ignored", "ignored")
    expect(result2).toBe(result1)
  })

  it("handles fast-path when oldText === newText", () => {
    const resEmpty = getOrComputeDiff("k-empty", "", "")
    expect(resEmpty.contentDiff).toEqual([])
    expect(resEmpty.summary).toEqual({ added: 0, removed: 0, unchanged: 0 })

    const text = "identical line 1\nidentical line 2"
    const res = getOrComputeDiff("k-identical", text, text)
    expect(res.contentDiff).toEqual([{ type: "ctx", line: text }])
    expect(res.summary).toEqual({ added: 0, removed: 0, unchanged: 1 })
  })

  it("computes metadata diff and titleChanged", () => {
    const res = getOrComputeDiff(
      "k-meta",
      "same",
      "same",
      JSON.stringify({ a: 1 }),
      JSON.stringify({ a: 2 }),
      "Old Title",
      "New Title",
    )
    expect(res.titleChanged).toBe(true)
    expect(res.metaDiff.length).toBeGreaterThan(0)
  })

  it("enforces bounded capacity with LRU eviction", () => {
    for (let i = 0; i < MAX_DIFF_CACHE_SIZE; i++) {
      setCachedDiff(`mem_${i}`, 1, 2, {
        summary: { added: i, removed: 0, unchanged: 0 },
        contentDiff: [],
        metaDiff: [],
        titleChanged: false,
      })
    }
    expect(getDiffCacheSize()).toBe(MAX_DIFF_CACHE_SIZE)

    // Oldest is mem_0
    expect(getCachedDiff("mem_0", 1, 2)).toBeDefined()
    // Accessing mem_0 moves it to MRU. Now mem_1 is oldest.

    // Add one more entry to trigger eviction
    setCachedDiff("overflow_mem", 1, 2, {
      summary: { added: 999, removed: 0, unchanged: 0 },
      contentDiff: [],
      metaDiff: [],
      titleChanged: false,
    })

    expect(getDiffCacheSize()).toBe(MAX_DIFF_CACHE_SIZE)
    // mem_1 should have been evicted
    expect(getCachedDiff("mem_1", 1, 2)).toBeUndefined()
    // mem_0 was accessed, so it should still be present
    expect(getCachedDiff("mem_0", 1, 2)).toBeDefined()
    // newly added entry should be present
    expect(getCachedDiff("overflow_mem", 1, 2)).toBeDefined()
  })
})
