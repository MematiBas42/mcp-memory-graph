import { ExtractionRule } from './types.js';

export const EN_EXTRACTION_RULES: ExtractionRule[] = [
  // 1. Incidents & Postmortems (High specificity)
  {
    type: 'incident',
    regex:
      /\b(?:(?:the\s+)?root cause|postmortem|the outage|the incident|went down|brought down|regression|broke production|service degradation|outage)\s*(?:was|were|is)?\s*[:;,]?\s*([^".!?\n]{15,250}[^\s.!?\n])(?:\.|\n|$)/gim,
    confidence: 0.5,
    language: 'en',
    description: 'English postmortem and root cause statements',
  },

  // 2. Lessons & Retrospectives (High specificity)
  {
    type: 'lesson',
    regex:
      /\b(?:lesson learned|in hindsight|next time|going forward|the takeaway|key takeaway)\s*[:;,]?\s*([^".!?\n]{15,250}[^\s.!?\n])(?:\.|\n|$)/gim,
    confidence: 0.4,
    language: 'en',
    description: 'English retrospective lessons learned',
  },

  // 3. Error Fixes - Structured pair (Issue -> Fix)
  {
    type: 'error_fix',
    regex:
      /\b(?:error|bug|issue|problem)\s*[:;]?\s*([^":—>\n]{5,150}[^\s:—>\n])\s*(?:—|--|->|=>|fix:)\s*([^".!?\n]{10,250}[^\s.!?\n])(?:\.|\n|$)/gim,
    confidence: 0.6,
    combineGroups: true,
    language: 'en',
    description: 'English structured error-to-fix mapping',
  },

  // Prefix error fix
  {
    type: 'error_fix',
    regex:
      /\b(?:fixed by|the fix (?:was|is)|solution (?:was|is)|resolved by|the issue (?:was|is)|the problem (?:was|is))\s*[:;]?\s*([^".!?\n]{15,250}[^\s.!?\n])(?:\.|\n|$)/gim,
    confidence: 0.6,
    language: 'en',
    description: 'English prefix error resolution',
  },

  // 4. Decisions (SVO)
  {
    type: 'decision',
    regex:
      /\b(?:decided|decision|agreed|chose|chosen|will use|going with|settled on|the approach is|we(?:'ll| will| should))\s*(?:to |that |on )?\s*([^".!?\n]{15,250}[^\s.!?\n])(?:\.|\n|$)/gim,
    confidence: 0.5,
    language: 'en',
    description: 'English architectural and technical decisions',
  },

  // 5. Patterns
  {
    type: 'pattern',
    regex:
      /\b(?:pattern|noticed that|turns out|learned that|discovered that|insight)\b\s*[:;]?\s*([^".!?\n]{15,250}[^\s.!?\n])(?:\.|\n|$)/gim,
    confidence: 0.4,
    language: 'en',
    description: 'English pattern and discovery insights',
  },

  // Dedicated case-sensitive acronym TIL (strictly without /i flag to avoid subword collisions)
  {
    type: 'pattern',
    regex: /\bTIL\b\s*[:;]?\s*([^".!?\n]{15,250}[^\s.!?\n])(?:\.|\n|$)/gm,
    confidence: 0.4,
    language: 'en',
    description: 'English case-sensitive TIL pattern',
  },

  // 6. Conventions
  {
    type: 'convention',
    regex:
      /\b(?:convention|standard|rule|policy|guideline|naming convention|must always|should always|never)\b\s*[:;]?\s*([^".!?\n]{15,250}[^\s.!?\n])(?:\.|\n|$)/gim,
    confidence: 0.4,
    language: 'en',
    description: 'English engineering convention and rule directives',
  },
];
