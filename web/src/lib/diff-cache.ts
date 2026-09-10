import { computeLineDiff, summarizeLineDiff, type DiffLine, type DiffSummary } from "./diff"

export const MAX_DIFF_CACHE_SIZE = 100

export interface DiffResult {
  summary: DiffSummary
  contentDiff: DiffLine[]
  metaDiff: DiffLine[]
  titleChanged: boolean
  diff?: DiffLine[]
}

const diffMap = new Map<string, any>()

/**
 * Builds standard cache key for diffs between two versions of a memory.
 */
export function makeDiffCacheKey(
  memoryId: string,
  v1: number | string,
  v2: number | string,
): string {
  return `${memoryId}_v${v1}_to_${v2}`
}

/**
 * Retrieves a cached diff by memoryId and versions, or direct cache key.
 */
export function getCachedDiff<T = DiffResult>(
  memoryId: string,
  v1?: number | string,
  v2?: number | string,
): T | undefined {
  const key = v1 !== undefined && v2 !== undefined ? makeDiffCacheKey(memoryId, v1, v2) : memoryId
  if (!diffMap.has(key)) return undefined
  const val = diffMap.get(key)
  // Refresh LRU order (delete & set moves to end of Map insertion order)
  diffMap.delete(key)
  diffMap.set(key, val)
  return val as T
}

/**
 * Stores a diff into bounded in-memory Map with LRU eviction.
 */
export function setCachedDiff<T = DiffResult>(
  memoryId: string,
  v1: number | string,
  v2: number | string,
  diff: T,
): void
export function setCachedDiff<T = DiffResult>(
  cacheKey: string,
  diff: T,
): void
export function setCachedDiff<T = DiffResult>(
  memoryIdOrKey: string,
  v1OrDiff: number | string | T,
  v2?: number | string,
  diff?: T,
): void {
  let key: string
  let val: T
  if (v2 !== undefined && diff !== undefined) {
    key = makeDiffCacheKey(memoryIdOrKey, v1OrDiff as number | string, v2)
    val = diff
  } else {
    key = memoryIdOrKey
    val = v1OrDiff as T
  }

  if (diffMap.has(key)) {
    diffMap.delete(key)
  } else if (diffMap.size >= MAX_DIFF_CACHE_SIZE) {
    const oldestKey = diffMap.keys().next().value
    if (oldestKey !== undefined) {
      diffMap.delete(oldestKey)
    }
  }
  diffMap.set(key, val)
}

/**
 * Clears the in-memory diff cache.
 */
export function clearDiffCache(): void {
  diffMap.clear()
}

/**
 * Returns current count of cached diff entries in memory.
 */
export function getDiffCacheSize(): number {
  return diffMap.size
}

/**
 * Computes or retrieves from in-memory cache a complete diff.
 * Past versions in SQLite are immutable, so in-memory caching is safe.
 */
export function getOrComputeDiff(
  cacheKey: string,
  oldText: string,
  newText: string,
  oldMetaStr = "",
  newMetaStr = "",
  oldTitle = "",
  newTitle = "",
): DiffResult {
  const cached = getCachedDiff<DiffResult>(cacheKey)
  if (cached) {
    return cached
  }

  // Fast-path: if text is completely identical, skip O(m*n) algorithm entirely
  let contentDiff: DiffLine[]
  let summary: DiffSummary

  if (oldText === newText) {
    contentDiff = oldText ? [{ type: "ctx", line: oldText }] : []
    summary = { added: 0, removed: 0, unchanged: contentDiff.length }
  } else {
    contentDiff = computeLineDiff(oldText, newText)
    summary = summarizeLineDiff(contentDiff)
  }

  // Meta diff
  const hasMeta = oldMetaStr !== newMetaStr && (oldMetaStr || newMetaStr)
  let metaDiff: DiffLine[] = []
  if (hasMeta) {
    metaDiff = computeLineDiff(oldMetaStr, newMetaStr)
  }

  const titleChanged = oldTitle !== newTitle

  const result: DiffResult = {
    summary,
    contentDiff,
    metaDiff,
    titleChanged,
    diff: contentDiff,
  }

  setCachedDiff<DiffResult>(cacheKey, result)

  return result
}
