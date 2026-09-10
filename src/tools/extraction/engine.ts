import {
  ExtractionCategory,
  ExtractionRule,
  ExtractedItem,
  ExtractionOptions,
  Language,
} from './types.js';
import { detectSentenceLanguage } from './detector.js';
import { TR_EXTRACTION_RULES } from './tr-patterns.js';
import { EN_EXTRACTION_RULES } from './en-patterns.js';

export const DEFAULT_MAX_EXTRACTIONS = 20;

/**
 * Validates that extracted content is natural language, not code/JSON/path fragments.
 * Fully Unicode-aware for Turkish and multilingual transcripts.
 */
export function isQualityContent(content: string): boolean {
  if (content.length < 30) return false;
  if (content.length > 500) return false;

  // Must contain at least 3 real words (>2 alpha chars each, Unicode-aware)
  const words = content.split(/\s+/);
  const realWords = words.filter((w) => (w.match(/[\p{L}]/gu) ?? []).length > 2);
  if (realWords.length < 3) return false;

  // At least 45% alphabetic or space characters (reject code/JSON/paths, Unicode-aware)
  const alphaSpaceCount = (content.match(/[\p{L}\s]/gu) ?? []).length;
  if (alphaSpaceCount / content.length < 0.45) return false;

  // Reject if starts with syntax/code indicators
  const firstChar = content.trimStart()[0];
  if (firstChar && '`|{}[]/<>#-+*='.includes(firstChar)) return false;

  // Reject if looks like a file path
  if (/^[\w/\\.-]+\.\w{1,5}$/.test(content.trim())) return false;

  // Reject if contains code patterns
  if (
    /(?:import\s+|require\(|function\s*\(|=>\s*\{|const\s+\w+\s*=|export\s+)/.test(
      content,
    )
  ) {
    return false;
  }

  return true;
}

/**
 * Generates a concise title from extracted content.
 */
export function generateTitle(content: string): string {
  const trimmed = content.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= 80) return trimmed;
  return trimmed.slice(0, 77) + '...';
}

/**
 * Modular extraction engine separating English SVO and Turkish SOV extraction logic.
 * Uses sentence-level segmentation (preserving dots in code, IPs, filenames)
 * and routes sentences to specialized pattern suites.
 */
export class ExtractionEngine {
  private readonly segmenter: Intl.Segmenter;

  constructor() {
    this.segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
  }

  /**
   * Extracts learnings from preprocessed transcript text.
   */
  public extract(cleanedText: string, options?: ExtractionOptions): ExtractedItem[] {
    const maxExtractions = options?.maxExtractions ?? DEFAULT_MAX_EXTRACTIONS;
    const allowedTypes =
      options?.categories && options.categories.length > 0
        ? new Set(options.categories)
        : null;

    const learnings: ExtractedItem[] = [];
    const seenContent = new Set<string>();
    const claimedSpans: [number, number][] = [];

    const segments = Array.from(this.segmenter.segment(cleanedText));

    for (const seg of segments) {
      if (learnings.length >= maxExtractions) break;
      const sentence = seg.segment.trim();
      if (!sentence) continue;

      // Determine language suite: explicit override or automatic sentence detection
      const lang: Language = options?.language ?? detectSentenceLanguage(sentence);
      let rules: ExtractionRule[];
      if (lang === 'tr') {
        rules = TR_EXTRACTION_RULES;
      } else if (lang === 'en') {
        rules = EN_EXTRACTION_RULES;
      } else {
        // Mixed: test Turkish rules first, then English rules
        rules = [...TR_EXTRACTION_RULES, ...EN_EXTRACTION_RULES];
      }

      // For Turkish and mixed text, normalize Turkish dotless/dotted I casing to avoid JS RegExp /iu Unicode case-folding limitations
      const textToMatch =
        lang === 'tr' || lang === 'mixed'
          ? seg.segment.toLocaleLowerCase('tr-TR')
          : seg.segment;

      for (const rule of rules) {
        if (learnings.length >= maxExtractions) break;
        if (allowedTypes && !allowedTypes.has(rule.type)) continue;

        rule.regex.lastIndex = 0;
        let match: RegExpExecArray | null;

        while ((match = rule.regex.exec(textToMatch)) !== null) {
          if (learnings.length >= maxExtractions) break;

          const matchStart = seg.index + match.index;
          const matchEnd = matchStart + match[0].length;

          // Prevent greedy subsumption: skip if text range overlaps with a higher-specificity extraction
          const isOverlapping = claimedSpans.some(([s, e]) => {
            const overlapStart = Math.max(matchStart, s);
            const overlapEnd = Math.min(matchEnd, e);
            return overlapEnd > overlapStart;
          });
          if (isOverlapping) continue;

          let content: string;
          if (rule.combineGroups && match[2]) {
            let part1 = match[1].trim();
            let part2 = match[2].trim();
            if (textToMatch !== seg.segment) {
              const rel1 = match[0].indexOf(match[1]);
              if (rel1 !== -1) {
                part1 = seg.segment.slice(match.index + rel1, match.index + rel1 + match[1].length).trim();
              }
              const rel2 = match[0].indexOf(match[2]);
              if (rel2 !== -1) {
                part2 = seg.segment.slice(match.index + rel2, match.index + rel2 + match[2].length).trim();
              }
            }
            part1 = part1.replace(/^[:;,"'“”«»\s]+/, '');
            part2 = part2
              .replace(/^[:;,"'“”«»\s]+/, '')
              .replace(/^(?:(?:çözüm|fix|düzeltme|solution)\s*[:;]?\s*)/iu, '');
            content = `Problem: ${part1} / Fix: ${part2}`;
          } else {
            let rawContent = match[1]?.trim() ?? '';
            if (textToMatch !== seg.segment && match[1]) {
              const relStart = match[0].indexOf(match[1]);
              if (relStart !== -1) {
                rawContent = seg.segment.slice(match.index + relStart, match.index + relStart + match[1].length).trim();
              }
            }
            content = rawContent
              .replace(/^[:;,"'“”«»\s]+/, '')
              .replace(/^(?:ki(?![\p{L}0-9])[:;]?\s*)/iu, '');
          }

          if (!isQualityContent(content)) continue;

          const normalized = content.toLocaleLowerCase('tr-TR');
          if (seenContent.has(normalized)) continue;
          seenContent.add(normalized);
          claimedSpans.push([matchStart, matchEnd]);

          learnings.push({
            type: rule.type,
            title: generateTitle(content),
            content,
            tags: ['auto-extracted', rule.type],
            confidence: rule.confidence,
            language: lang,
          });
        }
      }
    }

    return learnings;
  }
}

// Global singleton instance for shared usage
const defaultEngine = new ExtractionEngine();

export function extractWithEngine(
  cleanedText: string,
  options?: ExtractionOptions,
): ExtractedItem[] {
  return defaultEngine.extract(cleanedText, options);
}
