import { stemTurkish } from '../hooks/turkish-stemmer.js';

export const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'you', 'your',
  'can', 'please', 'should', 'would', 'could', 'have', 'has', 'what', 'when',
  'where', 'which', 'about', 'make', 'made', 'use', 'using', 'look', 'looked',
  'kan', 'skal', 'med', 'det', 'den', 'der', 'som', 'til', 'har', 'hvad',
]);

export const TR_STOPWORDS = new Set([
  'acaba','ama','aslında','az','bazı','belki','biri','birkaç','birşey','biz','bu',
  'çok','çünkü','da','daha','de','defa','diye','eğer','en','gibi','hem','hep','hepsi',
  'her','hiç','için','ile','ise','kez','ki','kim','mı','mu','mü','nasıl','ne','neden',
  'nerde','nerede','nereye','niçin','niye','o','sanki','şey','siz','şu','tüm','ve',
  'veya','ya','yani','ayarla','aç','bak','et','yap','etmek','yapmak','ederiz','yaparız'
]);

export const TECH_TOKENS = new Set([
  'api', 'sql', 'gpu', 'cpu', 'ram', 'git', 'mac', 'web', 'app', 'jwt',
  'tui', 'mcp', 'cli', 'ssh', 'lan', 'log', 'bug', 'env', 'dns', 'ssl',
  'db', 'ip', 'os', 'ui', 'id', 'ci', 'cd', 'sh', 'vm', 'io', 's3', 'k8s'
]);

export function trLowerCase(str: string): string {
  if (!str) return '';
  // Prevent English acronyms (API, IP, CLI) from becoming apı, ıp, clı under TR locale
  if (/^[A-Za-z0-9_-]+$/.test(str)) {
    return str.toLowerCase();
  }
  return str.toLocaleLowerCase('tr-TR').normalize('NFC');
}

const SEGMENTER = new Intl.Segmenter('tr-TR', { granularity: 'word' });

export function tokenizeText(prompt: string): string[] {
  const tokens = new Set<string>();
  
  for (const m of prompt.matchAll(/\b\d{4,7}\b/g)) tokens.add(m[0]);
  
  const noApostrophe = prompt.replace(/([\p{L}\p{N}]+)['’][\p{L}]+/gu, '$1');
  
  for (const { segment, isWordLike } of SEGMENTER.segment(noApostrophe)) {
    if (!isWordLike) continue;
    
    const tLower = trLowerCase(segment);
    if (!STOPWORDS.has(tLower) && !TR_STOPWORDS.has(tLower)) {
      if (tLower.length >= 4 || TECH_TOKENS.has(tLower) || /^[a-z]+\d+$/.test(tLower)) {
        const stem = stemTurkish(tLower);
        if (
          stem &&
          stem !== tLower &&
          !STOPWORDS.has(stem) &&
          !TR_STOPWORDS.has(stem) &&
          (stem.length >= 3 || TECH_TOKENS.has(stem))
        ) {
          tokens.add(stem);
        }
        tokens.add(tLower);
      }
    }
  }
  return [...tokens];
}
