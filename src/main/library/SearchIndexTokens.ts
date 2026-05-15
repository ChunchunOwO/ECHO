import { pinyin } from 'pinyin-pro';

export type SearchIndexTrackFields = {
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  genre?: string | null;
  path?: string | null;
  remotePath?: string | null;
};

const searchSeparatorPattern = /[\s!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~_-]+/u;
const cjkPattern = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const hanRunPattern = /\p{Script=Han}+/gu;
const cjkRunPattern = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const maxCjkGramLength = 3;
const maxPinyinWindow = 6;
const maxInitialWindow = 12;

const normalizeSearchText = (value: string): string => value.normalize('NFKC').trim().toLocaleLowerCase();

const addCjkGrams = (text: string, terms: Set<string>): void => {
  for (const match of text.matchAll(cjkRunPattern)) {
    const chars = Array.from(match[0]);

    for (let start = 0; start < chars.length; start += 1) {
      for (let length = 1; length <= maxCjkGramLength && start + length <= chars.length; length += 1) {
        terms.add(chars.slice(start, start + length).join(''));
      }
    }
  }
};

const addPinyinTokens = (text: string, terms: Set<string>): void => {
  for (const match of text.matchAll(hanRunPattern)) {
    const syllables = pinyin(match[0], { toneType: 'none', type: 'array' })
      .map((item) => normalizeSearchText(item))
      .filter(Boolean);

    if (syllables.length === 0) {
      continue;
    }

    const initials = syllables.map((syllable) => syllable[0] ?? '').join('');
    const compact = syllables.join('');
    terms.add(compact);
    terms.add(initials);

    for (let start = 0; start < syllables.length; start += 1) {
      for (let length = 1; length <= maxPinyinWindow && start + length <= syllables.length; length += 1) {
        const window = syllables.slice(start, start + length);
        terms.add(window.join(''));
        for (const syllable of window) {
          terms.add(syllable);
        }
      }

      for (let length = 1; length <= maxInitialWindow && start + length <= initials.length; length += 1) {
        terms.add(initials.slice(start, start + length));
      }
    }
  }
};

const addTextSearchTerms = (value: string | null | undefined, terms: Set<string>): void => {
  if (!value) {
    return;
  }

  const normalized = normalizeSearchText(value);
  if (!normalized) {
    return;
  }

  terms.add(normalized);

  const parts = normalized.split(searchSeparatorPattern).filter(Boolean);
  for (const part of parts) {
    terms.add(part);

    if (cjkPattern.test(part)) {
      addCjkGrams(part, terms);
    }
  }

  if (parts.length > 1) {
    terms.add(parts.join(''));
  }

  addCjkGrams(normalized, terms);
  addPinyinTokens(normalized, terms);
};

export const buildTrackSearchTerms = (fields: SearchIndexTrackFields): string => {
  const terms = new Set<string>();

  addTextSearchTerms(fields.title, terms);
  addTextSearchTerms(fields.artist, terms);
  addTextSearchTerms(fields.album, terms);
  addTextSearchTerms(fields.albumArtist, terms);
  addTextSearchTerms(fields.genre, terms);
  addTextSearchTerms(fields.path, terms);
  addTextSearchTerms(fields.remotePath, terms);

  return Array.from(terms).join(' ');
};
