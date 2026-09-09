import { describe, it, expect } from 'vitest';
import {
  tokenize,
  shouldRecall,
  rankMemories,
  formatRecall,
  trLowerCase,
  matchWordBoundary,
  type MemoryRow,
} from '../../hooks/memory-user-prompt.js';

describe('memory-user-prompt hook helpers', () => {
  describe('trLowerCase canonical normalization', () => {
    it('normalizes Turkish dotted/dotless I characters canonically to ASCII i while preserving other Turkish characters', () => {
      expect(trLowerCase('İşlem')).toBe('işlem');
      expect(trLowerCase('Işık')).toBe('işik');
      expect(trLowerCase('kullanıcı')).toBe('kullanici');
    });

    it('preserves matching for English acronyms and words with uppercase I', () => {
      expect(trLowerCase('API')).toBe('api');
      expect(trLowerCase('CLI')).toBe('cli');
      expect(trLowerCase('GIT')).toBe('git');
      expect(trLowerCase('UI')).toBe('ui');
      expect(trLowerCase('Internal')).toBe('internal');
    });
  });

  describe('tokenize', () => {
    it('extracts 4-7 digit ids and words >= 4 chars, drops stopwords', () => {
      const t = tokenize('continue the 4821 checkout deploy');
      expect(t).toContain('4821');
      expect(t).toContain('checkout');
      expect(t).toContain('deploy');
      expect(t).not.toContain('the'); // stopword
    });

    it('extracts allowed 3-char technical terms', () => {
      const t = tokenize('configure api and cli tools with git and gpu');
      expect(t).toContain('api');
      expect(t).toContain('cli');
      expect(t).toContain('git');
      expect(t).toContain('gpu');
      expect(t).toContain('tools');
    });

    it('extracts hyphenated technical terms', () => {
      const t = tokenize('switch to bge-m3 embedding model');
      expect(t).toContain('bge-m3');
      expect(t).toContain('embedding');
      expect(t).toContain('model');
    });

    it('drops words shorter than 4 chars when not in technical allowlist', () => {
      expect(tokenize('go to db now')).toEqual([]);
    });

    it('caps the token set so a long prompt cannot fan out unbounded', () => {
      const long = Array.from({ length: 40 }, (_, i) => `wordnum${i}`).join(' ');
      expect(tokenize(long).length).toBeLessThanOrEqual(8);
    });
  });

  describe('matchWordBoundary', () => {
    it('matches uppercase English technical acronyms against lowercase tokens', () => {
      expect(matchWordBoundary('API Gateway Configuration', 'api')).toBe(true);
      expect(matchWordBoundary('CLI Tools & Scripts', 'cli')).toBe(true);
      expect(matchWordBoundary('GIT Workflow Standards', 'git')).toBe(true);
      expect(matchWordBoundary('UI Design Guidelines', 'ui')).toBe(true);
      expect(matchWordBoundary('Internal Architecture Doc', 'internal')).toBe(true);
    });

    it('matches Turkish words with different cases', () => {
      expect(matchWordBoundary('İşlem Sırası ve Öncelik', 'işlem')).toBe(true);
      expect(matchWordBoundary('Kullanıcı Ayarları', 'kullanici')).toBe(true);
    });

    it('matches hyphenated terms cleanly', () => {
      expect(matchWordBoundary('Using bge-m3 embeddings', 'bge-m3')).toBe(true);
    });
  });

  describe('shouldRecall (signal gate, not word-prefix)', () => {
    it('fires when an id is present even with one word', () => {
      expect(shouldRecall(tokenize('deploy 4821'))).toBe(true);
    });

    it('fires on >=2 meaningful tokens', () => {
      expect(shouldRecall(tokenize('payment retry threshold'))).toBe(true);
    });

    it('fires on single technical 3-char token or single word >= 5 chars', () => {
      expect(shouldRecall(['api'])).toBe(true);
      expect(shouldRecall(['bge-m3'])).toBe(true);
    });

    it('does NOT fire on bare affirmations', () => {
      expect(shouldRecall(tokenize('yes please'))).toBe(false);
      expect(shouldRecall(tokenize('ok'))).toBe(false);
      expect(shouldRecall(tokenize('check now'))).toBe(false);
    });

    it('regression: a prompt STARTING with "continue" but carrying a task fires', () => {
      expect(shouldRecall(tokenize('continue the 4821 deploy'))).toBe(true);
    });
  });

  describe('rankMemories', () => {
    const rows: MemoryRow[] = [
      { id: 'aaaaaaaa-1', title: '#4821 checkout retry fix', content: 'payment deploy', importance_score: 0.3 },
      { id: 'bbbbbbbb-2', title: 'store hygiene', content: 'always pass a title when you deploy', importance_score: 0.9 },
      { id: 'cccccccc-3', title: 'unrelated note', content: 'nothing matching here', importance_score: 0.5 },
    ];

    it('ranks a strong title match above a high-importance weak body match', () => {
      const out = rankMemories(rows, tokenize('4821 checkout payment deploy'));
      expect(out[0].id).toBe('aaaaaaaa-1');
    });

    it('applies the match floor: a single weak body-word hit is excluded', () => {
      // "deploy" hits only row bbbb's body once (match=1) → below floor of 2.
      const out = rankMemories(rows, ['deploy']);
      expect(out).toHaveLength(0);
    });

    it('caps results at the limit', () => {
      const out = rankMemories(rows, tokenize('4821 checkout payment deploy'), 1);
      expect(out).toHaveLength(1);
    });
  });

  describe('formatRecall', () => {
    it('renders titled memories with explicit UUID, short id, and agent action directives', () => {
      const block = formatRecall([
        { id: 'b5951ab3-7cd4-4191-8e35-ce1436bb45ff', title: '#4821 fix', content: '', importance_score: 0.3 },
      ]);
      expect(block).toContain("[Context Recall]");
      expect(block).toContain("Directly matching memories found for this prompt:");
      expect(block).toContain("- Title: '#4821 fix'");
      expect(block).toContain("Memory ID: b5951ab3-7cd4-4191-8e35-ce1436bb45ff (short: b5951ab3)");
      expect(block).toContain("ACTION FOR AGENT:");
      expect(block).toContain('Do NOT run `memory_search` to re-find these.');
      expect(block).toContain('Use `memory_get(id="<Memory ID>")` directly to read the full document immediately.');
    });

    it('appends snippet when content is present', () => {
      const block = formatRecall([
        {
          id: 'b5951ab3-7cd4-4191-8e35-ce1436bb45ff',
          title: '#4821 fix',
          content: 'first line snippet\nsecond line ignored',
          importance_score: 0.3,
        },
      ]);
      expect(block).toContain("- Title: '#4821 fix'");
      expect(block).toContain("Memory ID: b5951ab3-7cd4-4191-8e35-ce1436bb45ff (short: b5951ab3)");
      expect(block).toContain("Snippet: first line snippet");
    });

    it('returns null when nothing titled survives', () => {
      expect(formatRecall([])).toBeNull();
      expect(formatRecall([{ id: 'x', title: null, content: 'c', importance_score: 0 }])).toBeNull();
    });
  });
});
