import { ExtractionRule } from './types.js';

export const TR_EXTRACTION_RULES: ExtractionRule[] = [
  // 1. Incidents & Postmortems (High specificity)
  {
    type: 'incident',
    regex:
      /(?<![\p{L}0-9])(?:kök neden|kesinti|hizmet kesintisi|sistem çökmesi|arıza|darboğaz)\s*(?:nedir|sebebi|kaynağı|idi)?\s*[:;,]\s*([^".!?\n]{15,250}[^\s.!?\n])(?:\.|\n|$)/guim,
    confidence: 0.5,
    language: 'tr',
    description: 'Turkish incident root causes and postmortem statements',
  },

  // 2. Lessons & Retrospectives (High specificity)
  {
    type: 'lesson',
    regex:
      /(?<![\p{L}0-9])(?:öğrenilen ders|çıkarılan ders|alınan ders|özetle|ana ders|temel ders|ders çıkar(?:dık|dım|ıldı|ılmalı(?:dır)?)|öğren(?:dik|dim|ildi|ilmeli(?:dir)?)\s+ki|tecrübe e(?:ttik|dildi)(?:\s+ki)?)\s*[:;,]?\s*([^".!?\n]{15,250}[^\s.!?\n])(?:\.|\n|$)/guim,
    confidence: 0.4,
    language: 'tr',
    description: 'Turkish lessons learned and retrospective insights',
  },

  // 3. Error Fixes - Structured pair (Problem -> Solution)
  {
    type: 'error_fix',
    regex:
      /(?<![\p{L}0-9])(?:hata|sorun|problem|arıza|çökme)\s*[:;]?\s*([^":—>\n]{5,150}[^\s:—>\n])\s*(?:—|--|->|=>|çözüm:|fix:)\s*([^".!?\n]{10,250}[^\s.!?\n])(?![\p{L}0-9])(?:\.|\n|$)/guim,
    confidence: 0.6,
    combineGroups: true,
    language: 'tr',
    description: 'Turkish structured problem-to-solution mapping',
  },

  // Prefix error fix: requires colon or semicolon (prevents suffix bleed like 'çözümü,')
  {
    type: 'error_fix',
    regex:
      /(?<![\p{L}0-9])(?:hata çözümü|çözüm|düzeltme)(?![\p{L}0-9])\s*[:;]\s*([^".!?\n]{15,250}[^\s.!?\n])(?:\.|\n|$)/guim,
    confidence: 0.6,
    language: 'tr',
    description: 'Turkish prefix error fix with required separator',
  },

  // Suffix error fix (SOV) - includes agglutinative loanword verbs like 'fixledik'
  {
    type: 'error_fix',
    regex:
      /((?:[^.!?\n]|\.(?![ \t\r\n]|$)){15,250}?)\s+(?:(?:ile )?çöz(?:üldü|dük|düm|ülüyor|ülecek|ülmeli(?:dir)?|üyoruz|üyorum|eceğiz|eceğim|meliyiz|meliyim)|(?:ile )?gider(?:ildi|dik|dim|iliyor|ilecek|ilmeli(?:dir)?|iyoruz|iyorum|eceğiz|eceğim|meliyiz|meliyim)|(?:şeklinde )?düzelt(?:ildi|tik|tim|iliyor|ilecek|ilmeli(?:dir)?|iyoruz|iyorum|eceğiz|eceğim|meliyiz|meliyim)|onar(?:ıldı|dık|dım|ılıyor|ılacak|ılmalı(?:dir)?|iyoruz|ıyorum|acağız|acağım)|halle(?:dildi|ttik|ttim|diliyor|dilecek|dilmeli(?:dir)?|diyoruz|diyorum|deceğiz|deceğim)|fixle(?:ndi|dik|dim|niyor|necek|nmeli(?:dir)?|niyoruz|niyorum|yeceğiz|yeceğim)|(?:sebebiyle|yüzünden)?\s*kaynaklan(?:dı|ıyor|maktadır|mıştır)|kaynaklıydı)(?![\p{L}0-9])(?:\.|\n|$)/guim,
    confidence: 0.6,
    language: 'tr',
    description: 'Turkish SOV predicate error fix and loanword verb fixledik',
  },

  // 4. Decisions
  // Prefix decision
  {
    type: 'decision',
    regex:
      /(?<![\p{L}0-9])(?:karar ver(?:dik|dim|ildi)|kararlaştır(?:dık|ıldı)|kararımız(?:dır)?|varılan karar|alınan karar)(?:\s+ki\s*[:;]?|\s*[:;])\s*([^".!?\n]{15,250}[^\s.!?\n])(?:\.|\n|$)/guim,
    confidence: 0.5,
    language: 'tr',
    description: 'Turkish prefix decision with conjunction or separator',
  },

  // Suffix decision (SOV) - includes technical loanword predicates
  {
    type: 'decision',
    regex:
      /((?:[^.!?\n]|\.(?![ \t\r\n]|$)){15,250}?)\s+(?:karar ver(?:dik|dim|ildi|iliyor|ilecek|ilmeli(?:dir)?|iyoruz|iyorum|eceğiz|eceğim|meliyiz|meliyim)|kararlaştır(?:dık|dım|ıldı|ılıyor|ılacak|ılmalı(?:dir)?|iyoruz|ıyorum|acağız|acağım|malıyız|malıyım)|(?:olarak )?seç(?:tik|tim|ildi|iliyor|ilecek|ilmeli(?:dir)?|iyoruz|iyorum|eceğiz|eceğim|meliyiz|meliyim)|karar(?:ı)? al(?:dık|dım|ındı|ınıyor|ınacak|ınmalı(?:dir)?|iyoruz|ıyorum|acağız|acağım|malıyız|malıyım)|tercih e(?:ttik|ttim|dildi|diliyor|dilecek|dilmeli(?:dir)?|diyoruz|diyorum|deceğiz|deceğim|tmeliyiz|tmeliyim)|uygun gör(?:dük|düm|üldü|ülüyor|ülecek|ülmeli(?:dir)?|üyoruz|üyorum)|adopt e(?:ttik|dildi)|deploy e(?:ttik|dildi)|refactor e(?:ttik|dildi)|mergele(?:dik|ndi))(?![\p{L}0-9])(?:\.|\n|$)/guim,
    confidence: 0.5,
    language: 'tr',
    description: 'Turkish SOV decision predicate and technical loanwords',
  },

  // 5. Patterns
  {
    type: 'pattern',
    regex:
      /(?<![\p{L}0-9])(?:kalıp|fark e(?:ttik|ttim|dildi|diliyor|dilecek|dilmeli(?:dir)?|diyoruz|diyorum|deceğiz|deceğim)(?:\s+ki)?|gör(?:dük|düm|üldü|üyoruz|üyorum|ülüyor|eceğiz|eceğim|ülecek)\s+ki|anlaşıl(?:dı|ıyor|acak)\s+ki|anla(?:dık|dım|yoruz)\s+ki|tespit e(?:ttik|ttim|dildi|diliyor|dilecek|dilmeli(?:dir)?|diyoruz|diyorum|deceğiz|deceğim)(?:\s+ki)?|keşfe(?:ttik|ttim|dildi|diliyor|dilecek|diyoruz|diyorum)(?:\s+ki)?|öğren(?:dik|dim|ildi|iyoruz|iliyor)\s+ki|gözlemle(?:dik|dim|ndi|niyor)(?:\s+ki)?)(?![\p{L}0-9])\s*[:;]?\s*([^".!?\n]{15,250}[^\s.!?\n])(?:\.|\n|$)/guim,
    confidence: 0.4,
    language: 'tr',
    description: 'Turkish cognitive/observational pattern extraction',
  },

  // 6. Conventions
  // Prefix convention
  {
    type: 'convention',
    regex:
      /(?<![\p{L}0-9])(?:standart|kural|yönerge|prensip|ilke)(?![\p{L}0-9])\s*[:;]\s*([^".!?\n]{15,250}[^\s.!?\n])(?:\.|\n|$)/guim,
    confidence: 0.4,
    language: 'tr',
    description: 'Turkish prefix convention with required separator',
  },

  // Suffix convention (SOV)
  {
    type: 'convention',
    regex:
      /((?:[^.!?\n]|\.(?![ \t\r\n]|$)){15,250}?)\s+(?:zorunlu(?:dur)?|kural(?:ıdır|dır)?|standardı(?:dır)?|standarttır|gerek(?:mektedir|lidir|ir|li)|[\p{L}]+[ıiuü]?[ln](?:malı|meli)(?:dır|dir)?|[\p{L}]+(?:malı|meli)y(?:ız|iz|ım|im)|[\p{L}]+[ıiuü]?[ln](?:acak|ecek)(?:tır|tir)?|[\p{L}]+[ıiuü]?[ln]m(?:akta|ekte)dir|dikkat et(?:meliyiz|meliyim)|asla\s+(?:yapılmamalı|kullanılmamalı|dokunulmamalı)(?:dır)?)(?![\p{L}0-9])(?:\.|\n|$)/guim,
    confidence: 0.4,
    language: 'tr',
    description: 'Turkish SOV convention, necessitative and mandatory policy',
  },
];
