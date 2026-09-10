import { describe, it, expect } from 'vitest';
import {
  preprocessTranscript,
  isQualityContent,
  extractFromTranscript,
} from '../../tools/extract-learnings.js';

describe('preprocessTranscript', () => {
  it('strips fenced code blocks', () => {
    const input = 'Before\n```typescript\nconst x = 1;\nconsole.log(x);\n```\nAfter';
    const result = preprocessTranscript(input);
    expect(result).toContain('Before');
    expect(result).toContain('After');
    expect(result).not.toContain('const x');
    expect(result).not.toContain('console.log');
  });

  it('strips inline code', () => {
    const input = 'We decided to use `React.memo` for performance';
    const result = preprocessTranscript(input);
    expect(result).toContain('We decided to use');
    expect(result).not.toContain('React.memo');
  });

  it('strips markdown table rows', () => {
    const input = 'Header\n| Name | Type | Description |\n|------|------|------|\n| foo | string | A foo |\nFooter';
    const result = preprocessTranscript(input);
    expect(result).toContain('Header');
    expect(result).toContain('Footer');
    expect(result).not.toContain('| foo |');
  });

  it('strips diff headers', () => {
    const input = 'Changes:\n--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,4 @@\nDone';
    const result = preprocessTranscript(input);
    expect(result).toContain('Changes:');
    expect(result).toContain('Done');
    expect(result).not.toContain('--- a/file.ts');
    expect(result).not.toContain('@@ -1,3');
  });

  it('strips XML-style tool markers', () => {
    const input = '<tool_call>\nsome json\n</tool_call>\nNatural language here';
    const result = preprocessTranscript(input);
    expect(result).toContain('Natural language here');
    expect(result).not.toContain('<tool_call>');
  });

  it('strips JSON-like lines', () => {
    const input = 'Result:\n{\n"name": "test",\n"value": 42\n}\nDone';
    const result = preprocessTranscript(input);
    expect(result).toContain('Result:');
    expect(result).toContain('Done');
    expect(result).not.toContain('"name": "test"');
  });

  it('strips bare file path lines', () => {
    const input = 'Found file:\nsrc/utils/helpers.ts\nMoving on';
    const result = preprocessTranscript(input);
    expect(result).toContain('Found file:');
    expect(result).toContain('Moving on');
    expect(result).not.toContain('src/utils/helpers.ts');
  });

  it('preserves natural language sentences', () => {
    const input = 'We decided to use React Query for data fetching. The approach is simpler than manual state management.';
    const result = preprocessTranscript(input);
    expect(result).toBe(input);
  });

  it('preserves sentences that mention file paths inline', () => {
    const input = 'The fix was in src/api/client.ts where we added a timeout.';
    const result = preprocessTranscript(input);
    expect(result).toContain('The fix was in');
  });

  it('collapses excessive whitespace', () => {
    const input = 'Line 1\n\n\n\n\nLine 2';
    const result = preprocessTranscript(input);
    expect(result).toBe('Line 1\n\nLine 2');
  });
});

describe('isQualityContent', () => {
  it('rejects content shorter than 30 chars', () => {
    expect(isQualityContent('too short')).toBe(false);
    expect(isQualityContent('s/notificationUtils')).toBe(false);
  });

  it('rejects content longer than 500 chars', () => {
    expect(isQualityContent('a '.repeat(300))).toBe(false);
  });

  it('rejects content with fewer than 3 real words', () => {
    expect(isQualityContent('ab cd ef gh ij kl mn op qr st')).toBe(false);
  });

  it('rejects content with too many non-alpha characters', () => {
    expect(isQualityContent('({[<>=!@#$%^&*()]}) -> {} => ()')).toBe(false);
  });

  it('rejects content starting with syntax chars', () => {
    expect(isQualityContent('| C# patterns, SQL, CQRS | OrdersAPI |')).toBe(false);
    expect(isQualityContent('`MeetingPreparationModal` component was recorded')).toBe(false);
    expect(isQualityContent('{key: value} is the configuration format we use')).toBe(false);
  });

  it('rejects file paths', () => {
    expect(isQualityContent('src/utils/notificationUtils.ts')).toBe(false);
  });

  it('rejects code patterns', () => {
    expect(isQualityContent('import React from react and then use it everywhere')).toBe(false);
    expect(isQualityContent('const handler = something that does the work here')).toBe(false);
    expect(isQualityContent('export default function that processes the data input')).toBe(false);
  });

  it('accepts natural language decisions', () => {
    expect(isQualityContent('Use React Query instead of manual fetch for all data loading operations')).toBe(true);
  });

  it('accepts natural language error fixes', () => {
    expect(isQualityContent('The timeout issue was caused by the connection pool being too small for production load')).toBe(true);
  });

  it('accepts natural language conventions', () => {
    expect(isQualityContent('Always run database migrations before deploying to the staging environment')).toBe(true);
  });

  it('accepts content with some numbers and special chars', () => {
    expect(isQualityContent('The API returns HTTP 429 errors when we exceed the rate limit of 100 requests per second')).toBe(true);
  });
});

describe('extractFromTranscript', () => {
  it('extracts decisions from clean natural language', () => {
    const transcript = 'We decided to use React Query for all data fetching in the mobile app. This simplifies caching.';
    const results = extractFromTranscript(transcript);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].type).toBe('decision');
    expect(results[0].content).toContain('React Query');
  });

  it('extracts error fixes', () => {
    const transcript = 'The fix was adding a retry mechanism with exponential backoff to the payment service calls.';
    const results = extractFromTranscript(transcript);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].type).toBe('error_fix');
  });

  it('produces zero results from pure code transcript', () => {
    const transcript = '```typescript\nconst decided = true;\nconst pattern = /test/;\nfunction fix() { return null; }\n```';
    const results = extractFromTranscript(transcript);
    expect(results).toHaveLength(0);
  });

  it('produces zero results from markdown table', () => {
    const transcript = '| Tool | Pattern | Description |\n|------|---------|-------------|\n| decided | convention | standard approach |';
    const results = extractFromTranscript(transcript);
    expect(results).toHaveLength(0);
  });

  it('caps extraction at 20 results', () => {
    // Create a transcript with many extractable sentences
    const sentences = Array.from({ length: 30 }, (_, i) =>
      `We decided to implement feature number ${i} with a completely different approach each time.`
    ).join('\n');
    const results = extractFromTranscript(sentences);
    expect(results.length).toBeLessThanOrEqual(20);
  });

  it('filters by categories when specified', () => {
    const transcript = [
      'We decided to use GraphQL for the new API endpoints.',
      'The fix was increasing the database connection pool size to handle more load.',
      'Learned that caching at the edge reduces latency significantly for static content.',
    ].join('\n');

    const decisionsOnly = extractFromTranscript(transcript, ['decision']);
    for (const r of decisionsOnly) {
      expect(r.type).toBe('decision');
    }
  });

  it('deduplicates within a single transcript', () => {
    const transcript = [
      'We decided to use Redis for caching all frequently accessed user profile data.',
      'We decided to use Redis for caching all frequently accessed user profile data.',
    ].join('\n');
    const results = extractFromTranscript(transcript);
    const redisResults = results.filter(r => r.content.toLowerCase().includes('redis'));
    expect(redisResults.length).toBeLessThanOrEqual(1);
  });

  it('assigns correct confidence scores', () => {
    const transcript = 'We decided to migrate the database schema before the next deployment window.';
    const results = extractFromTranscript(transcript);
    if (results.length > 0) {
      expect(results[0].confidence).toBe(0.5); // decision confidence
    }
  });

  it('extracts incidents from postmortem language', () => {
    const transcript = 'The root cause was a database connection pool exhausted under peak checkout traffic.';
    const results = extractFromTranscript(transcript);
    const incidents = results.filter((r) => r.type === 'incident');
    expect(incidents.length).toBeGreaterThan(0);
    expect(incidents[0].content).toContain('connection pool');
  });

  it('extracts lessons from hindsight language', () => {
    const transcript = 'Lesson learned: always add a circuit breaker before calling the third party payment API.';
    const results = extractFromTranscript(transcript);
    const lessons = results.filter((r) => r.type === 'lesson');
    expect(lessons.length).toBeGreaterThan(0);
    expect(lessons[0].content).toContain('circuit breaker');
  });

  it('filters to incident category only', () => {
    const transcript = [
      'We decided to use GraphQL for the new API endpoints.',
      'The root cause was an unindexed foreign key causing full table scans on every order lookup.',
    ].join('\n');
    const incidentsOnly = extractFromTranscript(transcript, ['incident']);
    expect(incidentsOnly.length).toBeGreaterThan(0);
    for (const r of incidentsOnly) {
      expect(r.type).toBe('incident');
    }
  });

  it('accepts Turkish natural language decisions and extracts correctly', () => {
    const transcript = 'Geliştirme ortamında veritabanı ayarlarını SQLite yerine Postgres olarak değiştirmeye karar verdik.';
    const results = extractFromTranscript(transcript);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].type).toBe('decision');
    expect(results[0].content).toContain('Postgres');
  });

  it('extracts Turkish decisions across 1st person singular, passive, continuous, future, and necessitative forms', () => {
    const cases = [
      { text: 'Performans artışı için bellek önbelleğinde Redis yerine Memcached kullanmaya karar verdim.', expected: 'decision' },
      { text: 'Büyük veri yüklerini optimize etmek adına mimaride Kafka kuyruğu kullanılmasına karar verildi.', expected: 'decision' },
      { text: 'Takım olarak arayüz katmanında Tailwind CSS yerine Emotion kütüphanesini seçiyoruz.', expected: 'decision' },
      { text: 'Yeni mikroservis mimarisinde haberleşme protokolü olarak gRPC kullanılması kararlaştırılacak.', expected: 'decision' },
      { text: 'Üretim ortamına geçişte kesinlikle dağıtık izleme için OpenTelemetry tercih edilmeli.', expected: 'decision' },
    ];

    for (const c of cases) {
      const res = extractFromTranscript(c.text);
      expect(res.length).toBeGreaterThan(0);
      expect(res[0].type).toBe(c.expected);
    }
  });

  it('extracts Turkish error fixes across multiple morphological forms', () => {
    const cases = [
      { text: 'Sunucu kilitlenmesine yol açan bellek sızıntısı sorunu bağlantı havuzunu sınırlandırarak çözdüm.', expected: 'error_fix' },
      { text: 'Kritik ödeme işlemlerindeki çift çekim hatası idempotency anahtarı eklenerek giderildi.', expected: 'error_fix' },
      { text: 'Mobil uygulamadaki oturum düşme problemi token yenileme mekanizması şeklinde düzeltiliyor.', expected: 'error_fix' },
      { text: 'Eski kütüphaneden kaynaklanan TLS 1.0 uyumsuzluğu paket güncellemesiyle çözülecek.', expected: 'error_fix' },
      { text: 'Yetkilendirme katmanındaki güvenlik açığı rol bazlı erişim denetimi uygulanarak düzeltilmelidir.', expected: 'error_fix' },
    ];

    for (const c of cases) {
      const res = extractFromTranscript(c.text);
      expect(res.length).toBeGreaterThan(0);
      expect(res[0].type).toBe(c.expected);
    }
  });

  it('extracts Turkish patterns and conventions across varied morphological forms', () => {
    // Pattern forms (1st singular, passive, continuous)
    const patternText = 'fark ettim: veritabanı bağlantı sayısı arttığında sorgu yanıt süreleri logaritmik olarak uzuyor.';
    const patternRes = extractFromTranscript(patternText);
    expect(patternRes.length).toBeGreaterThan(0);
    expect(patternRes[0].type).toBe('pattern');

    // Convention forms (passive necessitative, future, plural necessitative)
    const conventionCases = [
      'Tüm servis içi API isteklerinde correlation id başlığının iletilmesi zorunludur.',
      'Veritabanı şeması değişikliklerinde geriye dönük uyumluluk prensibi uygulanmalıdır.',
      'Her pull request birim test kapsamını en az yüzde seksen düzeyinde tutacak şekilde hazırlanmalıdır.',
    ];
    for (const text of conventionCases) {
      const res = extractFromTranscript(text);
      expect(res.length).toBeGreaterThan(0);
      expect(res[0].type).toBe('convention');
    }
  });

  it('accepts Turkish characters in isQualityContent', () => {
    expect(isQualityContent('Kullanıcı şifreleme anahtarlarını güvenli biçimde saklamamız gerektiği konusunda kararlaştırdık.')).toBe(true);
  });

  it('extracts learnings containing dots in technical terms without truncation', () => {
    const text = 'Veritabanı güncellemelerinde prisma.findUnique yerine tx.findUnique kullanılmasına karar verdik.';
    const res = extractFromTranscript(text);
    expect(res.length).toBeGreaterThan(0);
    expect(res[0].type).toBe('decision');
    expect(res[0].content).toContain('prisma.findUnique');
    expect(res[0].content).toContain('tx.findUnique');
  });

  it('extracts error fixes with IP addresses and filenames', () => {
    const text = 'Sunucu kilitlenmesi sorunu Redis 192.168.1.1 sunucusundaki config.ts ayarları güncellenerek çözüldü.';
    const res = extractFromTranscript(text);
    expect(res.length).toBeGreaterThan(0);
    expect(res[0].type).toBe('error_fix');
    expect(res[0].content).toContain('192.168.1.1');
  });

  it('handles Turkish uppercase and dotless I deduplication', () => {
    const text = [
      'Performans için Redis önbellek mekanizması kullanılmasına karar verildi.',
      'PERFORMANS İÇİN REDİS ÖNBELLEK MEKANİZMASI KULLANILMASINA KARAR VERİLDİ.',
    ].join('\n');
    const res = extractFromTranscript(text);
    expect(res).toHaveLength(1);
  });

  it('extracts decisions with prefix phrasing and colon / ki conjunction', () => {
    const text = 'Karar verildi ki: mikroservisler arası iletişimde RabbitMQ yerine NATS kullanılacak.';
    const res = extractFromTranscript(text);
    expect(res.length).toBeGreaterThan(0);
    expect(res[0].type).toBe('decision');
    expect(res[0].content).toContain('NATS');
  });

  it('extracts pairwise structured error fixes in Turkish', () => {
    const text = 'Hata: RecTV eklentisi 404 veriyor -> Çözüm: URI şemasını load time esnasında decrypt et.';
    const res = extractFromTranscript(text);
    expect(res.length).toBeGreaterThan(0);
    expect(res[0].type).toBe('error_fix');
    expect(res[0].content).toContain('RecTV');
    expect(res[0].content).toContain('decrypt');
  });

  it('extracts conventions with strict negative rules (asla yapılmamalı)', () => {
    const text = 'Kritik müşteri tablolarında cascade delete asla kullanılmamalıdır.';
    const res = extractFromTranscript(text);
    expect(res.length).toBeGreaterThan(0);
    expect(res[0].type).toBe('convention');
    expect(res[0].content).toContain('cascade delete');
  });

  it('extracts Turkish SRE incident root causes and lessons learned', () => {
    const incidentText = 'Kök neden: background worker process heap bellek sınırına ulaştığı için gerçekleşti.';
    const incRes = extractFromTranscript(incidentText);
    expect(incRes.length).toBeGreaterThan(0);
    expect(incRes[0].type).toBe('incident');
    expect(incRes[0].content).toContain('heap bellek');

    const lessonText = 'Öğrenilen ders: harici servis entegrasyonlarında daima katı timeout ve fallback koruması kurulmalıdır.';
    const lesRes = extractFromTranscript(lessonText);
    expect(lesRes.length).toBeGreaterThan(0);
    expect(lesRes[0].type).toBe('lesson');
    expect(lesRes[0].content).toContain('timeout');
  });

  it('avoids false-positive word substring extractions (çözümü, Düzeltilmiş/TIL)', () => {
    const text1 = 'Bir ajanın bulduğu çözümü, diğer iki ajana "bunda bir hata bulmaya çalışın" diyerek test ettirebiliriz.';
    expect(extractFromTranscript(text1)).toHaveLength(0);

    const text2 = 'Düzeltilmiş parametre ile saf JS Snowball testini çalıştırıyorum.';
    expect(extractFromTranscript(text2)).toHaveLength(0);

    const text3 = 'Hızlıca "karar verdik", "sorun çözüldü" gibi kelimeleri tarayıp bunları kurtarır.';
    expect(extractFromTranscript(text3)).toHaveLength(0);
  });

  it('extracts Turkish agglutinated loanword verbs (fixledik, deploy ettik, refactor ettik, mergeledik)', () => {
    const loanwordCases = [
      {
        text: 'Önbellek sızıntısı problemini Redis ttl süresini yapılandırarak fixledik.',
        expectedType: 'error_fix',
        contains: 'Redis ttl',
      },
      {
        text: 'Production ortamındaki kritik bellek taşması hatası hotfix ile fixlendi.',
        expectedType: 'error_fix',
        contains: 'bellek taşması',
      },
      {
        text: 'Kimlik doğrulama katmanını JWT yerine OAuth2 standardına göre refactor ettik.',
        expectedType: 'decision',
        contains: 'OAuth2',
      },
      {
        text: 'Staging ortamındaki yeni backend sürümünü Docker konteyneri ile deploy ettik.',
        expectedType: 'decision',
        contains: 'Docker',
      },
      {
        text: 'Kritik özellik dalını ana geliştirme koduna çakışmasız şekilde mergeledik.',
        expectedType: 'decision',
        contains: 'özellik dalı',
      },
    ];

    for (const c of loanwordCases) {
      const res = extractFromTranscript(c.text);
      expect(res.length).toBeGreaterThan(0);
      expect(res[0].type).toBe(c.expectedType);
      expect(res[0].content).toContain(c.contains);
    }
  });

  it('validates typological divergence: English SVO prefix vs Turkish SOV loanword predicate', () => {
    // English SVO
    const enText = 'We decided to use Redis for fast distributed session caching.';
    const enRes = extractFromTranscript(enText);
    expect(enRes.length).toBeGreaterThan(0);
    expect(enRes[0].type).toBe('decision');
    expect(enRes[0].content).toContain('Redis');

    // Turkish SOV with loanword verb
    const trText = 'Kullanıcı oturum verilerini yönetmek için Redis kullanmaya karar verdik.';
    const trRes = extractFromTranscript(trText);
    expect(trRes.length).toBeGreaterThan(0);
    expect(trRes[0].type).toBe('decision');
    expect(trRes[0].content).toContain('Redis');
  });
});
