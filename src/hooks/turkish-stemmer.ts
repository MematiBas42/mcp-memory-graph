// Turkish Stemmer implementation in pure TypeScript.
// Ported from cengizhancaliskan/turkishstemmer (Go) based on the paper:
// "An Affix Stripping Morphological Analyzer for Turkish" by Gülşen Eryiğit & Eşref Adalı (2004)
// and selection heuristics from "Information Retrieval on Turkish Texts" by Can et al. (2008).

export const AVERAGE_STEMMER_COUNT = 4;
export const MIN_SYLLABLE_COUNT = 2;

export const ALPHABET = 'abcçdefgğhıijklmnoöprsştuüvyz';
export const VOWELS = 'üiıueöao';
export const CONSONANTS = 'bcçdfgğhjklmnprsştvyz';
export const ROUNDED_VOWELS = 'oöuü';
export const FOLLOWING_ROUNDED_VOWELS = 'aeuü';
export const UNROUNDED_VOWELS = 'iıea';
export const FRONT_VOWELS = 'eiöü';
export const BACK_VOWELS = 'ıuao';

export const LAST_CONSONANT_RULES: Record<string, string> = {
  b: 'p',
  c: 'ç',
  d: 't',
  ğ: 'k',
};

export const LAST_CONSONANT_EXCEPTIONS = new Set<string>([
  'ad', 'at', 'ked', 'led',
]);

export const VOWEL_HARMONY_EXCEPTIONS = new Set<string>([
  'alkoller', 'değerın', 'saati', 'generali', 'generale',
  'projektörlar', 'saatler', 'tabletlar', 'tersyüz', 'yaninda', 'yani',
]);

export const AVERAGE_STEM_SIZE_EXCEPTIONS = new Set<string>([
  'al', 'am', 'aparat', 'ara', 'bilet', 'bisiklet', 'bulut', 'diyet', 'ev', 'es',
  'fiyat', 'fırsat', 'general', 'git', 'gıt', 'iç', 'ip', 'internet', 'iyi', 'kağıt',
  'kartuş', 'katı', 'kot', 'kötü', 'kumanda', 'lamba', 'mağaza', 'magaza', 'makara',
  'makine', 'marka', 'maskara', 'ne', 'otomat', 'palet', 'perde', 'raket', 'ranza',
  'robot', 'sepet', 'servis', 'soyad', 'su', 'tabaka', 'tablet', 'takım', 'talımat',
  'tanıt', 'tarla', 'tasma', 'tenis', 'törpü', 'uç', 'uygun', 'var', 'yasa', 'led', 'gaz',
]);

export const PROTECTED_WORDS = new Set<string>([
  'abiye', 'adın', 'adana', 'akılsız', 'alaska', 'alet', 'altı', 'altın', 'ağda', 'ağız',
  'alarm', 'altınbaşak', 'altınyıldız', 'anakucağı', 'anasayfa', 'anime', 'antifriz', 'araba',
  'ardeşen', 'armanı', 'aroma', 'arma', 'arsız', 'asa', 'askı', 'astra', 'asus', 'atkı',
  'ayakkabı', 'aydınlatma', 'aynı', 'ayı', 'banka', 'başka', 'batık', 'bayı', 'belge',
  'bellona', 'benten', 'benzin', 'beşinci', 'bilgi', 'bitki', 'boyut', 'branda', 'bütün',
  'buzlu', 'çağrı', 'çadır', 'camsız', 'canta', 'çanta', 'calar', 'çalar', 'çarşı', 'cavalli',
  'çerçeve', 'ceyiz', 'çıkış', 'cımbiz', 'çini', 'dalga', 'damla', 'derece', 'deniz', 'denim',
  'dişli', 'düğün', 'ege', 'elbise', 'fendi', 'filtre', 'fıfa', 'fiyat', 'forma', 'fular',
  'gazete', 'gemi', 'görüntü', 'halı', 'havuzu', 'havuzlu', 'igne', 'ince', 'internet',
  'iyi', 'karyola', 'kadın', 'kayısı', 'kama', 'kanepe', 'katı', 'killer', 'köşe', 'köse',
  'kötü', 'kuma', 'kumanda', 'küpe', 'kupa', 'koltuk', 'kolu', 'lamba', 'lazım', 'litre',
  'mağaza', 'magaza', 'makara', 'makine', 'malzeme', 'mana', 'marka', 'masa', 'maskara',
  'mine', 'mini', 'moda', 'nike', 'nine', 'numara', 'odun', 'oyun', 'ölçü', 'örgü', 'öykü',
  'özen', 'parça', 'perde', 'pompa', 'pırlanta', 'raket', 'ranza', 'şamdan', 'şapka', 'şifre',
  'salı', 'sunu', 'soyad', 'tabaka', 'takım', 'talımat', 'tarla', 'tasma', 'tekken', 'törpü',
  'tozlu', 'tüplü', 'uçurtma', 'üfleme', 'ürün', 'ütü', 'uygun', 'uzatma', 'uzun', 'vana',
  'vibe', 'yağlı', 'yapma', 'yardım', 'yasa', 'yıldız', 'zayıflama', 'zemin', 'kurutma', 'yazı',
]);

export function getVowels(word: string): string[] {
  const vowels: string[] = [];
  for (const char of word) {
    if (VOWELS.includes(char)) {
      vowels.push(char);
    }
  }
  return vowels;
}

export function countSyllables(word: string): number {
  return getVowels(word).length;
}

export function validateOptionalLetter(word: string, candidate: string): boolean {
  const chars = Array.from(word);
  if (chars.length - 2 < 0) {
    return false;
  }
  const previousChar = chars[chars.length - 2];
  if (VOWELS.includes(candidate)) {
    return CONSONANTS.includes(previousChar);
  }
  return VOWELS.includes(previousChar);
}

export function hasFrontness(vowel: string, candidate: string): boolean {
  return (FRONT_VOWELS.includes(vowel) && FRONT_VOWELS.includes(candidate)) ||
         (BACK_VOWELS.includes(vowel) && BACK_VOWELS.includes(candidate));
}

export function hasRoundness(vowel: string, candidate: string): boolean {
  return (UNROUNDED_VOWELS.includes(vowel) && UNROUNDED_VOWELS.includes(candidate)) ||
         (ROUNDED_VOWELS.includes(vowel) && FOLLOWING_ROUNDED_VOWELS.includes(candidate));
}

export function vowelHarmony(vowel: string, candidate: string): boolean {
  return hasRoundness(vowel, candidate) && hasFrontness(vowel, candidate);
}

export function hasVowelHarmony(word: string): boolean {
  const vowels = getVowels(word);
  if (vowels.length < 2) {
    return true;
  }
  const vowel = vowels[vowels.length - 2];
  const candidate = vowels[vowels.length - 1];
  return vowelHarmony(vowel, candidate);
}

export function isTurkishWord(word: string): boolean {
  for (const char of word) {
    if (!ALPHABET.includes(char)) {
      return false;
    }
  }
  return true;
}

export class Suffix {
  readonly name: string;
  readonly pattern: RegExp;
  readonly optionalLetterPattern: RegExp | null = null;
  readonly optionalLetterCheck: boolean = false;
  readonly checkHarmony: boolean;
  readonly optionalLetter: string = '';

  constructor(name: string, patternStr: string, optionalLetter: string, checkHarmony: boolean) {
    this.name = name;
    this.pattern = new RegExp(`(${patternStr})$`);
    if (optionalLetter.length > 0) {
      this.optionalLetterCheck = true;
      this.optionalLetter = optionalLetter;
      this.optionalLetterPattern = new RegExp(`(${optionalLetter})$`);
    }
    this.checkHarmony = checkHarmony;
  }

  match(word: string): boolean {
    return this.pattern.test(word);
  }

  getOptionalLetter(word: string): string | null {
    if (this.optionalLetterCheck && this.optionalLetterPattern) {
      const match = word.match(this.optionalLetterPattern);
      if (match && match[0]) {
        return match[0];
      }
    }
    return null;
  }

  removeSuffix(word: string): string {
    return word.replace(this.pattern, '');
  }
}

// Suffix instances
const DerivationalSuffix1 = new Suffix('-lU', 'lı|li|lu|lü', '', true);

const NominalVerbSuffix1  = new Suffix('-(y)Um', 'ım|im|um|üm', 'y', true);
const NominalVerbSuffix2  = new Suffix('-sUn', 'sın|sin|sun|sün', '', true);
const NominalVerbSuffix3  = new Suffix('-(y)Uz', 'ız|iz|uz|üz', 'y', true);
const NominalVerbSuffix4  = new Suffix('-sUnUz', 'sınız|siniz|sunuz|sünüz', '', true);
const NominalVerbSuffix5  = new Suffix('-lAr', 'lar|ler', '', true);
const NominalVerbSuffix6  = new Suffix('-m', 'm', '', true);
const NominalVerbSuffix7  = new Suffix('-n', 'n', '', true);
const NominalVerbSuffix8  = new Suffix('-k', 'k', '', true);
const NominalVerbSuffix9  = new Suffix('-nUz', 'nız|niz|nuz|nüz', '', true);
const NominalVerbSuffix10 = new Suffix('-DUr', 'tır|tir|tur|tür|dır|dir|dur|dür', '', true);
const NominalVerbSuffix11 = new Suffix('-cAsInA', 'casına|çasına|cesine|çesine', '', true);
const NominalVerbSuffix12 = new Suffix('-(y)DU', 'dı|di|du|dü|tı|ti|tu|tü', 'y', true);
const NominalVerbSuffix13 = new Suffix('-(y)sA', 'sa|se', 'y', true);
const NominalVerbSuffix14 = new Suffix('-(y)mUş', 'muş|miş|müş|mış', 'y', true);
const NominalVerbSuffix15 = new Suffix('-(y)ken', 'ken', 'y', true);

const NounSuffix1  = new Suffix('-lAr', 'lar|ler', '', true);
const NounSuffix2  = new Suffix('-(U)m', 'm', 'ı|i|u|ü', true);
const NounSuffix3  = new Suffix('-(U)mUz', 'mız|miz|muz|müz', 'ı|i|u|ü', true);
const NounSuffix4  = new Suffix('-Un', 'ın|in|un|ün', '', true);
const NounSuffix5  = new Suffix('-(U)nUz', 'nız|niz|nuz|nüz', 'ı|i|u|ü', true);
const NounSuffix6  = new Suffix('-(s)U', 'ı|i|u|ü', 's', true);
const NounSuffix7  = new Suffix('-lArI', 'ları|leri', '', true);
const NounSuffix8  = new Suffix('-(y)U', 'ı|i|u|ü', 'y', true);
const NounSuffix9  = new Suffix('-nU', 'nı|ni|nu|nü', '', true);
const NounSuffix10 = new Suffix('-(n)Un', 'ın|in|un|ün', 'n', true);
const NounSuffix11 = new Suffix('-(y)A', 'a|e', 'y', true);
const NounSuffix12 = new Suffix('-nA', 'na|ne', '', true);
const NounSuffix13 = new Suffix('-DA', 'da|de|ta|te', '', true);
const NounSuffix14 = new Suffix('-nDA', 'nta|nte|nda|nde', '', true);
const NounSuffix15 = new Suffix('-DAn', 'dan|tan|den|ten', '', true);
const NounSuffix16 = new Suffix('-nDAn', 'ndan|ntan|nden|nten', '', true);
const NounSuffix17 = new Suffix('-(y)lA', 'la|le', 'y', true);
const NounSuffix18 = new Suffix('-ki', 'ki', '', false);
const NounSuffix19 = new Suffix('-(n)cA', 'ca|ce', 'n', true);

const DerivationalSuffixValues = [DerivationalSuffix1];

const NominalVerbSuffixValues = [
  NominalVerbSuffix11, NominalVerbSuffix4, NominalVerbSuffix14, NominalVerbSuffix15,
  NominalVerbSuffix2, NominalVerbSuffix5, NominalVerbSuffix9, NominalVerbSuffix10,
  NominalVerbSuffix3, NominalVerbSuffix1, NominalVerbSuffix12, NominalVerbSuffix13,
  NominalVerbSuffix6, NominalVerbSuffix7, NominalVerbSuffix8,
];

const NounSuffixValues = [
  NounSuffix16, NounSuffix7, NounSuffix3, NounSuffix5, NounSuffix1, NounSuffix14,
  NounSuffix15, NounSuffix17, NounSuffix10, NounSuffix19, NounSuffix4, NounSuffix9,
  NounSuffix12, NounSuffix13, NounSuffix18, NounSuffix2, NounSuffix6, NounSuffix8,
  NounSuffix11,
];

export interface IState {
  readonly id: string;
  readonly initialState: boolean;
  readonly finalState: boolean;
  readonly suffixes: Suffix[];
  nextState(suffix: string): IState | null;
}

export class Transition {
  constructor(
    public startState: IState,
    public nextState: IState | null,
    public word: string,
    public suffix: Suffix,
    public marked = false,
  ) {}

  similarTransitions(transitions: Transition[]): Transition[] {
    const similars: Transition[] = [];
    for (const t of transitions) {
      if (this.startState.id === t.startState.id && this.nextState?.id === t.nextState?.id) {
        similars.push(t);
      }
    }
    return similars;
  }
}

// -------------------------------------------------------------
// NominalVerb State Machine
// -------------------------------------------------------------
class NominalVerbState implements IState {
  constructor(
    public readonly id: string,
    public readonly initialState: boolean,
    public readonly finalState: boolean,
    public readonly suffixes: Suffix[],
    private readonly transitions: () => Record<string, NominalVerbState>,
  ) {}

  nextState(suffix: string): IState | null {
    if (this.suffixes.length === 0) return null;
    return this.transitions()[suffix] ?? null;
  }
}

const NominalVerbStateA: NominalVerbState = new NominalVerbState('NVA', true, false, NominalVerbSuffixValues, () => NominalVerbTFValues);
const NominalVerbStateB: NominalVerbState = new NominalVerbState('NVB', false, true, [NominalVerbSuffix14], () => NominalVerbFTValues);
const NominalVerbStateC: NominalVerbState = new NominalVerbState('NVC', false, true, [NominalVerbSuffix10, NominalVerbSuffix12, NominalVerbSuffix13, NominalVerbSuffix14], () => NominalVerbFTValues);
const NominalVerbStateD: NominalVerbState = new NominalVerbState('NVD', false, false, [NominalVerbSuffix12, NominalVerbSuffix13], () => NominalVerbFFValues);
const NominalVerbStateE: NominalVerbState = new NominalVerbState('NVE', false, true, [NominalVerbSuffix1, NominalVerbSuffix2, NominalVerbSuffix3, NominalVerbSuffix4, NominalVerbSuffix5, NominalVerbSuffix14], () => NominalVerbFTValues);
const NominalVerbStateF: NominalVerbState = new NominalVerbState('NVF', false, true, [], () => ({}));
const NominalVerbStateG: NominalVerbState = new NominalVerbState('NVG', false, false, [NominalVerbSuffix14], () => NominalVerbFFValues);
const NominalVerbStateH: NominalVerbState = new NominalVerbState('NVH', false, false, [NominalVerbSuffix1, NominalVerbSuffix2, NominalVerbSuffix3, NominalVerbSuffix4, NominalVerbSuffix5, NominalVerbSuffix14], () => NominalVerbFFValues);

const NominalVerbTFValues: Record<string, NominalVerbState> = {
  [NominalVerbSuffix1.name]:  NominalVerbStateB,
  [NominalVerbSuffix2.name]:  NominalVerbStateB,
  [NominalVerbSuffix3.name]:  NominalVerbStateB,
  [NominalVerbSuffix4.name]:  NominalVerbStateB,
  [NominalVerbSuffix5.name]:  NominalVerbStateC,
  [NominalVerbSuffix6.name]:  NominalVerbStateD,
  [NominalVerbSuffix7.name]:  NominalVerbStateD,
  [NominalVerbSuffix8.name]:  NominalVerbStateD,
  [NominalVerbSuffix9.name]:  NominalVerbStateD,
  [NominalVerbSuffix10.name]: NominalVerbStateE,
  [NominalVerbSuffix11.name]: NominalVerbStateH,
  [NominalVerbSuffix12.name]: NominalVerbStateF,
  [NominalVerbSuffix13.name]: NominalVerbStateF,
  [NominalVerbSuffix14.name]: NominalVerbStateF,
  [NominalVerbSuffix15.name]: NominalVerbStateF,
};

const NominalVerbFTValues: Record<string, NominalVerbState> = {
  [NominalVerbSuffix1.name]:  NominalVerbStateG,
  [NominalVerbSuffix2.name]:  NominalVerbStateG,
  [NominalVerbSuffix3.name]:  NominalVerbStateG,
  [NominalVerbSuffix4.name]:  NominalVerbStateG,
  [NominalVerbSuffix5.name]:  NominalVerbStateG,
  [NominalVerbSuffix10.name]: NominalVerbStateF,
  [NominalVerbSuffix12.name]: NominalVerbStateF,
  [NominalVerbSuffix13.name]: NominalVerbStateF,
  [NominalVerbSuffix14.name]: NominalVerbStateF,
};

const NominalVerbFFValues: Record<string, NominalVerbState> = {
  [NominalVerbSuffix1.name]:  NominalVerbStateG,
  [NominalVerbSuffix2.name]:  NominalVerbStateG,
  [NominalVerbSuffix3.name]:  NominalVerbStateG,
  [NominalVerbSuffix4.name]:  NominalVerbStateG,
  [NominalVerbSuffix5.name]:  NominalVerbStateG,
  [NominalVerbSuffix12.name]: NominalVerbStateF,
  [NominalVerbSuffix13.name]: NominalVerbStateF,
  [NominalVerbSuffix14.name]: NominalVerbStateF,
};

// -------------------------------------------------------------
// Noun State Machine
// -------------------------------------------------------------
class NounState implements IState {
  constructor(
    public readonly id: string,
    public readonly initialState: boolean,
    public readonly finalState: boolean,
    public readonly suffixes: Suffix[],
    private readonly transitions: () => Record<string, NounState>,
  ) {}

  nextState(suffix: string): IState | null {
    if (this.suffixes.length === 0) return null;
    return this.transitions()[suffix] ?? null;
  }
}

const NounStateA = new NounState('NSA', true, true, NounSuffixValues, () => NounTTValues);
const NounStateB = new NounState('NSB', false, true, [NounSuffix1, NounSuffix2, NounSuffix3, NounSuffix4, NounSuffix5], () => NounFTValues);
const NounStateC = new NounState('NSC', false, false, [NounSuffix6, NounSuffix7], () => NounFFValues);
const NounStateD = new NounState('NSD', false, false, [NounSuffix10, NounSuffix13, NounSuffix14], () => NounFFValues);
const NounStateE = new NounState('NSE', false, true, [NounSuffix1, NounSuffix2, NounSuffix3, NounSuffix4, NounSuffix5, NounSuffix6, NounSuffix7, NounSuffix18], () => NounFTValues);
const NounStateF = new NounState('NSF', false, false, [NounSuffix6, NounSuffix7, NounSuffix18], () => NounFFValues);
const NounStateG = new NounState('NSG', false, true, [NounSuffix1, NounSuffix2, NounSuffix3, NounSuffix4, NounSuffix5, NounSuffix18], () => NounFTValues);
const NounStateH = new NounState('NSH', false, true, [NounSuffix1], () => NounFTValues);
const NounStateK = new NounState('NSK', false, true, [], () => ({}));
const NounStateL = new NounState('NSL', false, true, [NounSuffix18], () => NounFTValues);

const NounTTValues: Record<string, NounState> = {
  [NounSuffix1.name]:  NounStateL,
  [NounSuffix2.name]:  NounStateH,
  [NounSuffix3.name]:  NounStateH,
  [NounSuffix4.name]:  NounStateH,
  [NounSuffix5.name]:  NounStateH,
  [NounSuffix6.name]:  NounStateH,
  [NounSuffix7.name]:  NounStateK,
  [NounSuffix8.name]:  NounStateB,
  [NounSuffix9.name]:  NounStateC,
  [NounSuffix10.name]: NounStateE,
  [NounSuffix11.name]: NounStateB,
  [NounSuffix12.name]: NounStateF,
  [NounSuffix13.name]: NounStateB,
  [NounSuffix14.name]: NounStateF,
  [NounSuffix15.name]: NounStateG,
  [NounSuffix16.name]: NounStateC,
  [NounSuffix17.name]: NounStateE,
  [NounSuffix18.name]: NounStateD,
};

const NounFTValues: Record<string, NounState> = {
  [NounSuffix1.name]:  NounStateL,
  [NounSuffix2.name]:  NounStateH,
  [NounSuffix3.name]:  NounStateH,
  [NounSuffix4.name]:  NounStateH,
  [NounSuffix5.name]:  NounStateH,
  [NounSuffix6.name]:  NounStateH,
  [NounSuffix7.name]:  NounStateK,
  [NounSuffix18.name]: NounStateD,
};

const NounFFValues: Record<string, NounState> = {
  [NounSuffix6.name]:  NounStateH,
  [NounSuffix7.name]:  NounStateL,
  [NounSuffix10.name]: NounStateE,
  [NounSuffix13.name]: NounStateB,
  [NounSuffix14.name]: NounStateF,
  [NounSuffix18.name]: NounStateD,
};

// -------------------------------------------------------------
// Derivational State Machine
// -------------------------------------------------------------
class DerivationalState implements IState {
  constructor(
    public readonly id: string,
    public readonly initialState: boolean,
    public readonly finalState: boolean,
    public readonly suffixes: Suffix[],
  ) {}

  nextState(suffix: string): IState | null {
    if (this.suffixes.length > 0 && this.initialState && DerivationalSuffix1.name === suffix) {
      return DerivationalStateB;
    }
    return null;
  }
}

const DerivationalStateA = new DerivationalState('DSA', true, false, DerivationalSuffixValues);
const DerivationalStateB = new DerivationalState('DSB', false, true, []);

// -------------------------------------------------------------
// TurkishStemmer Class
// -------------------------------------------------------------
export class TurkishStemmer {
  private readonly protectedWords = PROTECTED_WORDS;
  private readonly vowelHarmonyExceptions = VOWEL_HARMONY_EXCEPTIONS;
  private readonly lastConsonantExceptions = LAST_CONSONANT_EXCEPTIONS;
  private readonly averageStemSizeExceptions = AVERAGE_STEM_SIZE_EXCEPTIONS;

  stem(word: string, tryCount = 0): string {
    const trimmed = word.trim();
    if (!this.validateWord(trimmed)) {
      return trimmed;
    }

    const stems: string[] = [];

    // 1. Nominal verb suffix state machine
    this.genericSuffixStripper(NominalVerbStateA, trimmed, stems);
    let wordsToStem = [...stems, trimmed];

    // 2. Noun suffix state machine
    for (const w of wordsToStem) {
      this.genericSuffixStripper(NounStateA, w, stems);
    }

    wordsToStem = [...stems, trimmed];

    // Typo recovery rule: if no suffix stripped, try swapping last letter u/ü or ı/i
    if (wordsToStem.includes(trimmed) && wordsToStem.length < 2 && tryCount < 1) {
      const runes = Array.from(trimmed);
      const lastIdx = runes.length - 1;
      const lastLetter = runes[lastIdx];
      let wordChanged = false;

      if (lastLetter === 'u') {
        runes[lastIdx] = 'ü';
        wordChanged = true;
      } else if (lastLetter === 'ü') {
        runes[lastIdx] = 'u';
        wordChanged = true;
      } else if (lastLetter === 'ı') {
        runes[lastIdx] = 'i';
        wordChanged = true;
      } else if (lastLetter === 'i') {
        runes[lastIdx] = 'ı';
        wordChanged = true;
      }

      if (wordChanged) {
        return this.stem(runes.join(''), 1);
      }
    }

    // 3. Derivational suffix state machine
    for (const w of wordsToStem) {
      this.genericSuffixStripper(DerivationalStateA, w, stems);
    }

    return this.postProcess(stems, trimmed);
  }

  private genericSuffixStripper(state: IState, word: string, stems: string[]): void {
    const transitions: Transition[] = [];
    this.addTransitions(state, word, transitions, state);

    while (transitions.length > 0) {
      const transition = transitions.shift()!;
      const stem = this.stemWord(transition.word, transition.suffix);

      if (stem !== transition.word && transition.nextState) {
        if (transition.nextState.finalState) {
          // Prune redundant transitions
          for (let i = 0; i < transitions.length; i++) {
            const t = transitions[i];
            if (
              t.marked ||
              (t.startState.id === transition.startState.id &&
               t.nextState?.id === transition.nextState?.id)
            ) {
              transitions.splice(i, 1);
              i--;
            }
          }

          stems.push(stem);
          this.addTransitions(transition.nextState, stem, transitions, transition.nextState);
        } else {
          for (const similar of transition.similarTransitions(transitions)) {
            similar.marked = true;
          }
          this.addTransitions(transition.nextState, stem, transitions, transition.nextState);
        }
      }
    }
  }

  private addTransitions(state: IState, word: string, transitions: Transition[], startState: IState): void {
    for (const suffix of state.suffixes) {
      if (suffix.match(word)) {
        transitions.push(new Transition(
          startState,
          startState.nextState(suffix.name),
          word,
          suffix,
        ));
      }
    }
  }

  private stemWord(word: string, suffix: Suffix): string {
    let stemmedWord = word;
    if (this.shouldBeMarked(word, suffix) && suffix.match(word)) {
      stemmedWord = suffix.removeSuffix(stemmedWord);
    }

    const optionalLetter = suffix.getOptionalLetter(stemmedWord);
    if (optionalLetter !== null) {
      if (validateOptionalLetter(stemmedWord, optionalLetter)) {
        const runes = Array.from(stemmedWord);
        stemmedWord = runes.slice(0, runes.length - 1).join('');
      } else {
        stemmedWord = word;
      }
    }
    return stemmedWord;
  }

  private shouldBeMarked(word: string, suffix: Suffix): boolean {
    return (
      !this.protectedWords.has(word) &&
      ((suffix.checkHarmony && hasVowelHarmony(word)) ||
        this.vowelHarmonyExceptions.has(word) ||
        !suffix.checkHarmony)
    );
  }

  private postProcess(stems: string[], word: string): string {
    const finalStems: string[] = [];
    for (const w of stems) {
      if (w !== word && countSyllables(w) > 0) {
        finalStems.push(this.lastConsonant(w));
      }
    }

    this.sortStems(finalStems);

    if (finalStems.length > 0) {
      return finalStems[0];
    }
    return word;
  }

  private sortStems(stems: string[]): void {
    stems.sort((a, b) => {
      if (this.averageStemSizeExceptions.has(a)) return -1;
      if (this.averageStemSizeExceptions.has(b)) return 1;

      const s1Len = Array.from(a).length;
      const s2Len = Array.from(b).length;

      const aDist = Math.abs(s1Len - AVERAGE_STEMMER_COUNT);
      const bDist = Math.abs(s2Len - AVERAGE_STEMMER_COUNT);
      const diff = aDist - bDist;
      if (diff === 0) {
        return s1Len - s2Len;
      }
      return diff;
    });
  }

  private validateWord(word: string): boolean {
    if (
      word.length < 1 ||
      this.protectedWords.has(word) ||
      !isTurkishWord(word) ||
      countSyllables(word) < MIN_SYLLABLE_COUNT
    ) {
      return false;
    }
    return true;
  }

  private lastConsonant(word: string): string {
    if (this.lastConsonantExceptions.has(word)) {
      return word;
    }
    const runes = Array.from(word);
    if (runes.length === 0) return word;
    const lastChar = runes[runes.length - 1];
    const replaceChar = LAST_CONSONANT_RULES[lastChar];
    if (replaceChar) {
      runes[runes.length - 1] = replaceChar;
      return runes.join('');
    }
    return word;
  }
}

// Export singleton instance and helper
export const defaultTurkishStemmer = new TurkishStemmer();

export function stemTurkish(word: string): string {
  return defaultTurkishStemmer.stem(word);
}
