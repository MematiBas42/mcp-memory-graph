export type ExtractionCategory =
  | 'decision'
  | 'pattern'
  | 'error_fix'
  | 'convention'
  | 'incident'
  | 'lesson';

export type Language = 'tr' | 'en' | 'mixed';

export interface ExtractionRule {
  type: ExtractionCategory;
  regex: RegExp;
  confidence: number;
  combineGroups?: boolean;
  language: 'tr' | 'en' | 'any';
  description?: string;
}

export interface ExtractedItem {
  type: ExtractionCategory;
  title: string;
  content: string;
  tags: string[];
  confidence: number;
  language?: Language;
}

export interface ExtractionOptions {
  categories?: ExtractionCategory[];
  language?: Language;
  maxExtractions?: number;
}
