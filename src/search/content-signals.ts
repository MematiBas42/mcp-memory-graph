import type { VolatilityClass } from '../types.js';

const RULES_RE =
  /(?<![\p{L}0-9])(?:rule|must|never|always|required|mandatory|strictly|enforce|forbidden|kural|kuralları|zorunlu|zorunludur|asla|kesinlikle|şart|şarttır|gereklidir|gerekir|yapılmalı|yapılmalıdır|edilmeli|edilmelidir|uyulmalı|uyulmalıdır|dokunulmamalı|yasak|yasaktır)(?![\p{L}0-9])/iu;
const DECISIONS_RE =
  /(?<![\p{L}0-9])(?:decision|decided|chose|chosen|because|rationale|adopted|architecture|karar|karar verildi|kararlaştırıldı|seçildi|seçtik|tercih edildi|tercih ettik|çünkü|nedeniyle|sebebiyle|gerekçesiyle|uygun görüldü)(?![\p{L}0-9])/iu;
const ERRORS_RE =
  /(?<![\p{L}0-9])(?:bug|fix|fixed|error|incident|broke|broken|failed|failure|crash|crashed|leak|leaked|hata|hatası|çözüm|çözümü|çözüldü|çözdük|sorun|sorunu|arıza|çökme|çöktü|düzeltildi|düzeltme|onarılmalı|onarıldı|halledebildik|halledildi|fixlendi|fixledik|kaynaklıydı)(?![\p{L}0-9])/iu;
const CODE_BLOCK_RE = /```/;
const DRAFT_RE =
  /(?<![\p{L}0-9])(?:todo|placeholder|draft|wip|tbd|taslak|geçici|yapılacak|tamamlanacak)(?![\p{L}0-9])/iu;

/**
 * Content that asserts a point-in-time/operational state — the kind of claim
 * that goes stale fast ("deployed", "live in PROD", "verified", "currently…").
 * Tuned to the failure that motivated this: a "UAT-verified" memory trusted a
 * day after it was written. Kept beside the other content regexes for one-place
 * tuning.
 */
const VOLATILE_RE =
  /(?<![\p{L}0-9])(?:deployed|deploy|in prod|production|rolled out|currently|as of|right now|today|this (?:week|sprint)|now live|in progress|pending|canlıda|yayında|şu anda|şu an|bugün|bu hafta|aktif olarak|geçici|sürmekte|(?:ci|test(?:ler)?|build)\s+(?:passing|failing|green|red|başarılı|başarısız))(?![\p{L}0-9])/iu;

/** document_type values whose facts are inherently operational/point-in-time. */
const VOLATILE_DOC_TYPES = new Set(['deploy', 'status', 'incident', 'incident-status', 'session', 'task-status']);
/** document_type values whose facts are durable references/agreements. */
const STABLE_DOC_TYPES = new Set(['reference', 'contract', 'policy', 'decision', 'adr', 'spec', 'convention', 'architecture', 'sop']);

/**
 * Classify how fast a memory's truth decays, from its content + document_type.
 * Drives tier-specific freshness warnings on recall (see freshnessWarning).
 * Document-type signal wins over content (an explicit type is a stronger intent
 * than incidental wording); within content, volatile wording wins over nothing.
 */
export function classifyVolatility(content: string, documentType?: string | null): VolatilityClass {
  const dt = documentType?.toLowerCase().trim();
  if (dt) {
    if (VOLATILE_DOC_TYPES.has(dt)) return 'volatile';
    if (STABLE_DOC_TYPES.has(dt)) return 'stable';
  }
  if (VOLATILE_RE.test(content)) return 'volatile';
  return 'normal';
}

export function computeContentSignal(content: string, documentType?: string | null): number {
  let score = 0.5;

  // Document-type baseline adjustments
  const dt = documentType?.toLowerCase().trim();
  if (dt) {
    if (dt === 'convention' || dt === 'policy' || dt === 'contract') score += 0.10;
    else if (dt === 'decision' || dt === 'architecture' || dt === 'sop') score += 0.05;
    else if (dt === 'error_fix' || dt === 'incident' || dt === 'lesson') score += 0.05;
  }

  // Boosts
  if (RULES_RE.test(content)) score += 0.15;
  if (DECISIONS_RE.test(content)) score += 0.10;
  if (ERRORS_RE.test(content)) score += 0.10;
  if (CODE_BLOCK_RE.test(content)) score += 0.05;

  // Penalties
  if (DRAFT_RE.test(content)) score -= 0.15;
  if (content.length < 100) score -= 0.10;

  return Math.max(0, Math.min(1, score));
}

export function maturityTier(importance: number): 'draft' | 'validated' | 'core' {
  if (importance >= 0.85) return 'core';
  if (importance >= 0.65) return 'validated';
  return 'draft';
}
