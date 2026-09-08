export type DiffOp = "ctx" | "del" | "add"

export interface DiffLine {
  type: DiffOp
  line: string
}

export interface DiffSummary {
  added: number
  removed: number
  unchanged: number
}

/**
 * Line diff between two strings using LCS algorithm.
 */
export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n")
  const b = newText.split("\n")
  const m = a.length
  const n = b.length

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ type: "ctx", line: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", line: a[i] })
      i++
    } else {
      out.push({ type: "add", line: b[j] })
      j++
    }
  }
  while (i < m) out.push({ type: "del", line: a[i++] })
  while (j < n) out.push({ type: "add", line: b[j++] })
  return out
}

export function summarizeLineDiff(diff: DiffLine[]): DiffSummary {
  let added = 0
  let removed = 0
  let unchanged = 0
  for (const d of diff) {
    if (d.type === "add") added++
    else if (d.type === "del") removed++
    else unchanged++
  }
  return { added, removed, unchanged }
}
