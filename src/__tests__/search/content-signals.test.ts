import { describe, it, expect } from 'vitest';
import { classifyVolatility, computeContentSignal } from '../../search/content-signals.js';

/**
 * classifyVolatility derives how fast a memory's truth decays from its content +
 * document_type. document_type is the stronger intent signal and wins over
 * incidental wording; within content, deploy/state phrasing marks a fact volatile.
 * The motivating failure: a "UAT-verified" note that was trusted a day later.
 */
describe('classifyVolatility', () => {
  it('flags deploy/state wording as volatile', () => {
    expect(classifyVolatility('The fix is deployed to PROD and verified live')).toBe('volatile');
    expect(classifyVolatility('event-24 is now live, smoke test passing')).toBe('volatile');
    expect(classifyVolatility('Currently the job runs every 5 minutes')).toBe('volatile');
    expect(classifyVolatility('Bu servis canlıda aktif olarak çalışıyor')).toBe('volatile');
    expect(classifyVolatility('Şu anda geçici yapılandırma devrede')).toBe('volatile');
  });

  it('treats durable explanatory content as normal', () => {
    expect(classifyVolatility('A stored procedure is one object; ALTER replaces the whole body.')).toBe('normal');
    expect(classifyVolatility('The pattern uses MediatR for command handling.')).toBe('normal');
    expect(classifyVolatility('TypeScript projelerinde esm modülleri kullanılmalıdır.')).toBe('normal');
  });

  it('lets document_type override to volatile even without trigger words', () => {
    expect(classifyVolatility('see the linked board', 'status')).toBe('volatile');
    expect(classifyVolatility('whatever', 'incident-status')).toBe('volatile');
  });

  it('lets document_type mark durable references stable, beating volatile wording', () => {
    // Content says "currently" (volatile) but a contract is a durable reference.
    expect(classifyVolatility('currently in effect', 'contract')).toBe('stable');
    expect(classifyVolatility('the decision, deployed', 'decision')).toBe('stable');
    expect(classifyVolatility('reference text', 'reference')).toBe('stable');
    expect(classifyVolatility('Git commit kuralları şu anda geçerlidir', 'convention')).toBe('stable');
    expect(classifyVolatility('Sistem mimarisi', 'architecture')).toBe('stable');
  });

  it('is case-insensitive on document_type and content', () => {
    expect(classifyVolatility('DEPLOYED TO PRODUCTION')).toBe('volatile');
    expect(classifyVolatility('x', 'STATUS')).toBe('volatile');
    expect(classifyVolatility('y', 'CONVENTION')).toBe('stable');
  });

  it('defaults to normal for plain content and null document_type', () => {
    expect(classifyVolatility('just a note', null)).toBe('normal');
    expect(classifyVolatility('just a note')).toBe('normal');
  });
});

describe('computeContentSignal with Turkish & English Heuristics', () => {
  it('boosts Turkish mandatory conventions and rules', () => {
    const text = 'Git commit işlemlerinde asla force push yapılmamalıdır. Bu kural tüm ekip üyeleri ve alt ajanlar için kesinlikle zorunludur.';
    const score = computeContentSignal(text, 'convention');
    expect(score).toBeGreaterThanOrEqual(0.75);
  });

  it('boosts Turkish architectural decisions', () => {
    const text = 'Veritabanı olarak SQLite ve sqlite-vec seçildi çünkü yerel ilkeli mimaride en yüksek performansı sağlamaktadır.';
    const score = computeContentSignal(text, 'decision');
    expect(score).toBeGreaterThanOrEqual(0.65);
  });

  it('boosts Turkish error fixes with code blocks', () => {
    const text = 'Hydration hatası düzeltildi: SSR aşamasında render edilen statik buton DOM üzerinden silinerek çözüldü. ```const btn = null;```';
    const score = computeContentSignal(text, 'error_fix');
    expect(score).toBeGreaterThanOrEqual(0.70);
  });

  it('penalizes drafts and short content', () => {
    const draft = computeContentSignal('Bu henüz bir taslak ve geçici yapılacaklar listesidir.');
    expect(draft).toBeLessThan(0.40);

    const short = computeContentSignal('Kısa not.');
    expect(short).toBeLessThanOrEqual(0.40);
  });
});
