import { computeLineDiff, summarizeLineDiff, type DiffLine, type DiffSummary } from "./diff"

const CACHE_PREFIX = "mcp_diff_cache_"
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

interface CacheEntry {
  ts: number // timestamp
  summary: DiffSummary
  diff: DiffLine[]
  metaDiff?: DiffLine[]
  titleChanged?: boolean
}

/**
 * Sweeps expired diff entries from localStorage to keep storage clean.
 */
export function sweepExpiredDiffCache(): void {
  try {
    const now = Date.now()
    const keysToRemove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && key.startsWith(CACHE_PREFIX)) {
        try {
          const item = JSON.parse(localStorage.getItem(key) || "")
          if (item?.ts && now - item.ts > ONE_WEEK_MS) {
            keysToRemove.push(key)
          }
        } catch {
          keysToRemove.push(key)
        }
      }
    }
    for (const k of keysToRemove) {
      localStorage.removeItem(k)
    }
  } catch {
    // Ignore storage quota or access errors
  }
}

/**
 * Computes or retrieves from 7-day localStorage cache a complete diff.
 * Past versions in SQLite are immutable, so this cache is 100% safe.
 */
export function getOrComputeDiff(
  cacheKey: string,
  oldText: string,
  newText: string,
  oldMetaStr = "",
  newMetaStr = "",
  oldTitle = "",
  newTitle = "",
): {
  summary: DiffSummary
  contentDiff: DiffLine[]
  metaDiff: DiffLine[]
  titleChanged: boolean
} {
  const fullKey = `${CACHE_PREFIX}${cacheKey}`

  // 1. Try reading from 1-week local storage cache
  try {
    const cachedRaw = localStorage.getItem(fullKey)
    if (cachedRaw) {
      const cached = JSON.parse(cachedRaw) as CacheEntry
      if (Date.now() - cached.ts < ONE_WEEK_MS) {
        return {
          summary: cached.summary,
          contentDiff: cached.diff,
          metaDiff: cached.metaDiff || [],
          titleChanged: !!cached.titleChanged,
        }
      }
    }
  } catch {
    // Fall back to computation if JSON parse fails
  }

  // 2. Fast-path: if text is completely identical, skip O(m*n) algorithm entirely
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

  // 3. Store into cache with 7-day TTL
  try {
    const entry: CacheEntry = {
      ts: Date.now(),
      summary,
      diff: contentDiff,
      metaDiff,
      titleChanged,
    }
    localStorage.setItem(fullKey, JSON.stringify(entry))
  } catch {
    // Storage quota might be exceeded for massive files; fails gracefully
  }

  return {
    summary,
    contentDiff,
    metaDiff,
    titleChanged,
  }
}
