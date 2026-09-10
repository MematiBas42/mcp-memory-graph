import { describe, it, expect } from 'vitest';
import {
  stemTurkish,
  defaultTurkishStemmer,
  hasVowelHarmony,
  countSyllables,
  isTurkishWord,
} from '../../hooks/turkish-stemmer.js';

describe('Turkish Stemmer (TypeScript Port)', () => {
  describe('Go stemmer_test.go test suite parity', () => {
    const parityCases = [
      { actual: 'eriklimişsincesine', expected: 'erik' },
      { actual: 'ayfon', expected: 'ayfon' },
      { actual: 'adrese', expected: 'adre' },
      { actual: 'abiyeler', expected: 'abiye' },
      { actual: 'guzelim', expected: 'guzel' },
      { actual: 'satıyorsunuz', expected: 'satıyor' },
      { actual: 'taksicisiniz', expected: 'taksiç' },
      { actual: 'türkiyedir', expected: 'türki' },
      { actual: 'telefonları', expected: 'telefon' },
      { actual: 'acana', expected: 'acan' },
      { actual: 'tekken', expected: 'tekken' },
      { actual: 'telefonu', expected: 'telefon' },
      { actual: 'telefon', expected: 'telefon' },
      { actual: 'alarm', expected: 'alarm' },
      { actual: 'alarmı', expected: 'alarm' },
      { actual: 'adını', expected: 'adın' },
      { actual: 'adın', expected: 'adın' },
      { actual: 'altın', expected: 'altın' },
      { actual: 'aparatı', expected: 'aparat' },
      { actual: 'arada', expected: 'ara' },
      { actual: 'arasındaki', expected: 'ara' },
      { actual: 'arasındakı', expected: 'arasındak' },
      { actual: 'gozluklerinde', expected: 'gozluk' },
      { actual: 'monitoru', expected: 'monitor' },
      { actual: 'monitörü', expected: 'monitör' },
      { actual: 'monitorü', expected: 'monitor' },
      { actual: 'monitöru', expected: 'monitör' },
      { actual: 'çantası', expected: 'çanta' },
      { actual: 'çantasıı', expected: 'çantası' },
      { actual: 'çantasi', expected: 'çanta' },
      { actual: 'ağrılı', expected: 'ağrı' },
    ];

    for (const { actual, expected } of parityCases) {
      it(`stems "${actual}" -> "${expected}"`, () => {
        expect(stemTurkish(actual)).toBe(expected);
      });
    }
  });

  describe('Real-world memory queries and critical exceptions', () => {
    const queryCases = [
      { actual: 'erişimini', expected: 'erişim' },
      { actual: 'bağlantılarını', expected: 'bağlantı' },
      { actual: 'ayarlarını', expected: 'ayar' },
      { actual: 'planda', expected: 'plan' },
      { actual: 'süreçleri', expected: 'süreç' },
      { actual: 'kuralları', expected: 'kural' },
      { actual: 'standartları', expected: 'standart' },
      { actual: 'kitaplardan', expected: 'kitap' },
      { actual: 'dosyalarında', expected: 'dosya' },
      { actual: 'geliştiricisi', expected: 'geliştirici' },
      { actual: 'abarttılar', expected: 'abart' },
      { actual: 'evlerdi', expected: 'ev' },
    ];

    for (const { actual, expected } of queryCases) {
      it(`accurately stems query word "${actual}" -> "${expected}"`, () => {
        expect(stemTurkish(actual)).toBe(expected);
      });
    }
  });

  describe('Validation & Phonetics', () => {
    it('validates Turkish alphabet words', () => {
      expect(isTurkishWord('saatler')).toBe(true);
      expect(isTurkishWord('türkçe')).toBe(true);
      expect(isTurkishWord('qué pasa')).toBe(false);
    });

    it('counts syllables accurately', () => {
      expect(countSyllables('araba')).toBe(3);
      expect(countSyllables('plan')).toBe(1);
      expect(countSyllables('kontrolleri')).toBe(4);
    });

    it('verifies vowel harmony', () => {
      expect(hasVowelHarmony('kapı')).toBe(true);
      expect(hasVowelHarmony('gözlük')).toBe(true);
      expect(hasVowelHarmony('kitap')).toBe(false);
    });

    it('short-circuits protected and single-syllable words', () => {
      expect(stemTurkish('tekken')).toBe('tekken');
      expect(stemTurkish('ağda')).toBe('ağda');
      expect(stemTurkish('ev')).toBe('ev');
    });
  });

  describe('Performance / Microbenchmark', () => {
    it('executes in microsecond timeframe', () => {
      const start = performance.now();
      const words = ['erişimini', 'bağlantılarını', 'ayarlarını', 'planda', 'süreçleri'];
      for (let i = 0; i < 2000; i++) {
        for (const w of words) {
          stemTurkish(w);
        }
      }
      const elapsed = performance.now() - start;
      const avgPerWordMicroseconds = (elapsed / 10000) * 1000;
      // Should easily be under 50 microseconds per word
      expect(avgPerWordMicroseconds).toBeLessThan(50);
    });
  });
});
