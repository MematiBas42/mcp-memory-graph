import { describe, it, expect } from 'vitest';
import {
  detectSentenceLanguage,
  ExtractionEngine,
  extractWithEngine,
  isQualityContent,
  generateTitle,
  TR_EXTRACTION_RULES,
  EN_EXTRACTION_RULES,
} from '../../tools/extraction/index.js';

describe('Modular Extraction Subsystem', () => {
  describe('detectSentenceLanguage', () => {
    it('detects Turkish from unique characters (ç, ğ, ı, ö, ş, ü, İ)', () => {
      expect(detectSentenceLanguage('Bu mimaride veritabanı şeması güncellenmelidir.')).toBe('tr');
      expect(detectSentenceLanguage('Önbellek mekanizması için yeni bir çözüm bulduk.')).toBe('tr');
    });

    it('detects Turkish from agglutinated loanword verbs in technical contexts', () => {
      expect(detectSentenceLanguage('Backend servisini staging ortamına deploy ettik.')).toBe('tr');
      expect(detectSentenceLanguage('Kritik bellek sızıntısını hotfix ile fixledik.')).toBe('tr');
      expect(detectSentenceLanguage('Auth modülünü OAuth2 standardına refactor ettik.')).toBe('tr');
      expect(detectSentenceLanguage('Geliştirme dalını ana koda sorunsuz mergeledik.')).toBe('tr');
      expect(detectSentenceLanguage('Son değişiklikleri git commitledik.')).toBe('tr');
    });

    it('detects English for standard technical phrases without Turkish markers', () => {
      expect(detectSentenceLanguage('We decided to use Redis for distributed caching.')).toBe('en');
      expect(detectSentenceLanguage('The connection pool timeout issue was resolved by increasing max connections.')).toBe('en');
      expect(detectSentenceLanguage('Always validate user input on system boundaries.')).toBe('en');
    });

    it('handles short or neutral technical sentences gracefully', () => {
      expect(detectSentenceLanguage('OK')).toBe('mixed');
      expect(detectSentenceLanguage('npm run build')).toBe('mixed');
    });
  });

  describe('isQualityContent', () => {
    it('accepts substantive natural language statements in Turkish and English', () => {
      expect(
        isQualityContent('Kullanıcı oturum bilgilerini saklamak için Redis önbellek mekanizması tercih edildi.'),
      ).toBe(true);
      expect(
        isQualityContent('We decided to migrate the monolith application to distributed microservices.'),
      ).toBe(true);
    });

    it('rejects code blocks, JSON, syntax characters, and file paths', () => {
      expect(isQualityContent('const x = require("fs");')).toBe(false);
      expect(isQualityContent('export async function test() {}')).toBe(false);
      expect(isQualityContent('{ "error": 500, "message": "fail" }')).toBe(false);
      expect(isQualityContent('/var/log/nginx/access.log')).toBe(false);
      expect(isQualityContent('src/tools/extraction/engine.ts')).toBe(false);
      expect(isQualityContent('### Header line only')).toBe(false);
      expect(isQualityContent('Too short.')).toBe(false);
    });
  });

  describe('generateTitle', () => {
    it('truncates content longer than 80 characters with ellipsis', () => {
      const longText = 'Bu çok uzun bir kararın başlığı olup seksen karakter sınırını aşmaktadır ve özetlenmelidir.';
      const title = generateTitle(longText);
      expect(title.length).toBeLessThanOrEqual(80);
      expect(title.endsWith('...')).toBe(true);
    });

    it('preserves content within 80 characters without modification', () => {
      const shortText = 'Redis önbellek mekanizması kuruldu.';
      expect(generateTitle(shortText)).toBe(shortText);
    });
  });

  describe('ExtractionEngine Core Logic', () => {
    const engine = new ExtractionEngine();

    it('does not truncate words starting with "ki" (Kimlik, Kitap, Kişisel)', () => {
      const text = 'Kimlik doğrulama katmanını JWT yerine OAuth2 standardına göre refactor ettik.';
      const results = engine.extract(text);
      expect(results.length).toBe(1);
      expect(results[0].content).toMatch(/^Kimlik doğrulama/);
      expect(results[0].content).not.toMatch(/^mlik/);
    });

    it('correctly trims the conjunction "ki" and colon without losing sentence substance', () => {
      const text = 'Karar verildi ki: mikroservisler arası iletişimde RabbitMQ yerine NATS kullanılacak.';
      const results = engine.extract(text);
      expect(results.length).toBe(1);
      expect(results[0].content).toMatch(/^mikroservisler arası/);
      expect(results[0].content).not.toMatch(/^ki[:;\s]/i);
    });

    it('extracts Turkish ALL-CAPS SOV rules with full original casing preservation', () => {
      const text = 'Veritabanı migration süreçlerinde geriye dönük uyumsuz alan silme işlemi ASLA YAPILMAMALIDIR.';
      const results = engine.extract(text);
      expect(results.length).toBe(1);
      expect(results[0].type).toBe('convention');
      expect(results[0].content).toBe('Veritabanı migration süreçlerinde geriye dönük uyumsuz alan silme işlemi');
    });

    it('extracts technical identifiers containing dots without sentence premature segmentation', () => {
      const text = 'Veritabanı transaction yönetiminde prisma.findUnique yerine tx.findUnique kullanılmasına karar verdik.';
      const results = engine.extract(text);
      expect(results.length).toBe(1);
      expect(results[0].content).toContain('prisma.findUnique');
      expect(results[0].content).toContain('tx.findUnique');
    });

    it('prevents overlapping matches using claimedSpans', () => {
      // Contains both decision and convention cues in one clause
      const text = 'Sistem güvenliği için API isteklerinde JWT zorunlu olup Redis kullanılmasına karar verdik.';
      const results = engine.extract(text);
      // Only the dominant span should be claimed, not multiple overlapping extractions for the same words
      expect(results.length).toBe(1);
    });

    it('honors category filter and maxExtractions limit', () => {
      const multiText = [
        'Performans için Redis kullanılmasına karar verdik.',
        'Hafıza sızıntısı sorunu havuz boyutu sınırlandırılarak çözüldü.',
        'Tüm API isteklerinde correlation id başlığı zorunludur.',
      ].join('\n');

      const decisionsOnly = engine.extract(multiText, { categories: ['decision'] });
      expect(decisionsOnly.every((d) => d.type === 'decision')).toBe(true);

      const capped = engine.extract(multiText, { maxExtractions: 1 });
      expect(capped).toHaveLength(1);
    });

    it('extracts pairwise structured error fixes cleanly', () => {
      const text = 'Hata: RecTV eklentisi 404 veriyor -> Çözüm: URI şemasını load time esnasında decrypt et.';
      const results = engine.extract(text);
      expect(results.length).toBe(1);
      expect(results[0].type).toBe('error_fix');
      expect(results[0].content).toContain('Problem: RecTV eklentisi 404 veriyor');
      expect(results[0].content).toContain('Fix: URI şemasını load time esnasında decrypt et');
    });

    it('rejects false-positive word substrings', () => {
      const falsePositives = [
        'Bir ajanın bulduğu çözümü, diğer iki ajana "bunda bir hata bulmaya çalışın" diyerek test ettirebiliriz.',
        'Düzeltilmiş parametre ile saf JS Snowball testini çalıştırıyorum.',
        'TIL kısaltması Today I Learned anlamına gelir.',
      ];

      for (const fp of falsePositives) {
        expect(engine.extract(fp)).toHaveLength(0);
      }
    });
  });

  describe('Rule definitions integrity', () => {
    it('all TR rules have descriptions, valid regexes, and defined categories', () => {
      for (const rule of TR_EXTRACTION_RULES) {
        expect(rule.type).toBeDefined();
        expect(rule.regex).toBeInstanceOf(RegExp);
        expect(rule.confidence).toBeGreaterThan(0);
        expect(rule.language).toBe('tr');
        expect(rule.description).toBeDefined();
      }
    });

    it('all EN rules have descriptions, valid regexes, and defined categories', () => {
      for (const rule of EN_EXTRACTION_RULES) {
        expect(rule.type).toBeDefined();
        expect(rule.regex).toBeInstanceOf(RegExp);
        expect(rule.confidence).toBeGreaterThan(0);
        expect(rule.language).toBe('en');
        expect(rule.description).toBeDefined();
      }
    });
  });
});
