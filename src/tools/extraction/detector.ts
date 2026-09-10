import { Language } from './types.js';

const TR_CHARS_REGEX = /[çğıöşüİ]/i;

const TR_VERBAL_SUFFIXES = [
  // Past tense / person agreement
  /(?:dik|dık|duk|dük|tik|tık|tuk|tük)$/i,
  // Passive past tense
  /(?:ildi|ıldı|uldu|üldü)$/i,
  // Necessitative mood
  /(?:malı|meli)(?:dır|dir|yiz|yız)?$/i,
  // Continuous aspect
  /(?:makta|mekte)dir$/i,
  // Future tense
  /(?:acak|ecek)(?:tır|tir)?$/i,
  // Perfect aspect
  /(?:mıştır|miştir|muştur|müştür)$/i,
];

// Loanword verbs that take Turkish derivational/inflectional affixes
const TR_LOANWORD_VERB_REGEX =
  /\b(?:fixle(?:ndi|dik|dim|niyor|necek|nmeli|yeceğiz|miş)|mergele(?:ndi|dik|dim|niyor|necek|yeceğiz)|deploy\s+e(?:ttik|ttim|dildi|diliyor|deceğiz)|refactor\s+e(?:ttik|ttim|dildi|diliyor|deceğiz)|commitle(?:dik|ndi)|test\s+e(?:ttik|ttim|dildi))\b/i;

const TR_COMMON_WORDS = new Set([
  've', 'veya', 'ile', 'için', 'bu', 'bir', 'şu', 'o', 'ama', 'fakat', 'çünkü',
  'olarak', 'diye', 'gibi', 'kadar', 'daha', 'çok', 'en', 'ise', 'ya', 'yani',
  'biz', 'siz', 'onlar', 'bunu', 'buna', 'şunu', 'bunun', 'şunun', 'burada',
  'karar', 'hata', 'sorun', 'problem', 'çözüm', 'yapmak', 'etmek', 'ederiz',
  'yaparız', 'ettik', 'yaptık', 'neden', 'nasıl', 'nerede', 'şeklinde',
  'yerine', 'adına', 'uygun', 'kritik', 'kural', 'standart', 'özetle',
]);

const EN_COMMON_WORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'because', 'have',
  'has', 'had', 'would', 'should', 'could', 'were', 'was', 'been', 'which',
  'about', 'into', 'over', 'after', 'decision', 'decided', 'approach', 'pattern',
  'convention', 'standard', 'incident', 'outage', 'lesson', 'learned',
  'error', 'issue', 'problem', 'fix', 'solution', 'resolved', 'always', 'never',
]);

/**
 * Fast sentence-level language classification for routing extraction rules.
 * Correctly classifies loanword agglutinative verbs (e.g., "fixledik") as Turkish.
 */
export function detectSentenceLanguage(sentence: string): Language {
  const trimmed = sentence.trim();
  if (!trimmed) return 'en';

  // 1. Definite Turkish markers (characters unique to Turkish alphabet)
  const hasTrChars = TR_CHARS_REGEX.test(trimmed);

  // 2. Loanword agglutinative verbs (e.g., "fixledik", "deploy ettik")
  const hasTrLoanwordVerb = TR_LOANWORD_VERB_REGEX.test(trimmed);

  const words = trimmed
    .toLowerCase()
    .replace(/[^\p{L}0-9\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);

  if (words.length === 0) return 'en';

  let trScore = 0;
  let enScore = 0;

  if (hasTrChars) trScore += 3;
  if (hasTrLoanwordVerb) trScore += 4;

  for (const word of words) {
    if (TR_COMMON_WORDS.has(word)) {
      trScore += 1.5;
    }
    if (EN_COMMON_WORDS.has(word)) {
      enScore += 1.5;
    }

    // Check Turkish verbal suffix patterns on non-trivial words
    if (word.length >= 5) {
      for (const suffixPattern of TR_VERBAL_SUFFIXES) {
        if (suffixPattern.test(word)) {
          trScore += 1;
          break;
        }
      }
    }
  }

  // Routing decision
  if (trScore >= 2 && enScore >= 2) {
    return 'mixed';
  }
  if (trScore > enScore || (hasTrChars && enScore === 0) || hasTrLoanwordVerb) {
    return 'tr';
  }
  if (enScore > trScore) {
    return 'en';
  }

  // Fallback for code-heavy or ambiguous sentences
  return 'mixed';
}
