import { describe, expect, it } from 'vitest';
import { buildFtsSearchQuery } from './LibraryStore';
import { buildTrackSearchTerms } from './SearchIndexTokens';

const baseFields = {
  artist: 'Echo Artist',
  album: 'Echo Album',
  albumArtist: 'Echo Artist',
};

describe('buildTrackSearchTerms', () => {
  it('adds Chinese grams, full pinyin, and pinyin initials', () => {
    const terms = buildTrackSearchTerms({
      ...baseFields,
      title: '会魔法的老人',
    }).split(' ');

    expect(terms).toEqual(expect.arrayContaining(['魔法', '老人', 'mofa', 'laoren', 'hmf']));
  });

  it('normalizes punctuation and path tokens without requiring a full path scan', () => {
    const terms = buildTrackSearchTerms({
      ...baseFields,
      title: 'Bootleg Live Take',
      path: 'D:\\Music\\Bootleg-Live-Take.flac',
    }).split(' ');

    expect(terms).toEqual(expect.arrayContaining(['bootleg', 'live', 'take', 'bootleglivetake']));
  });
});

describe('buildFtsSearchQuery', () => {
  it('escapes FTS syntax terms and expands cross-script Chinese variants', () => {
    expect(buildFtsSearchQuery('magic OR "live"')).toBe('magic* AND "OR" AND live*');
    expect(buildFtsSearchQuery('爱与梦')).toContain('愛與夢*');
  });

  it('honors the cross-script search switch', () => {
    expect(buildFtsSearchQuery('爱与梦', { chineseCrossScriptSearchEnabled: false })).toBe('爱与梦*');
  });
});
