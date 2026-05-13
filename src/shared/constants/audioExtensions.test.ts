import { describe, expect, it } from 'vitest';
import { isCueFile, isSupportedAudioExtension, SUPPORTED_AUDIO_DIALOG_EXTENSIONS } from './audioExtensions';

describe('audio extension constants', () => {
  it('supports common, hifi, dsd, container, and cue formats', () => {
    const supported = ['.flac', '.mp3', '.m4a', '.alac', '.opus', '.cue', '.dsf', '.dff', '.ape', '.wv', '.mka', '.mkv', '.mp4', '.tta', '.tak'];

    for (const extension of supported) {
      expect(isSupportedAudioExtension(`D:\\Music\\Track${extension}`)).toBe(true);
      expect(isSupportedAudioExtension(`/music/Track${extension.toUpperCase()}`)).toBe(true);
    }
  });

  it('does not treat artwork, lyrics, documents, or executables as audio', () => {
    const unsupported = ['.jpg', '.png', '.txt', '.lrc', '.pdf', '.exe'];

    for (const extension of unsupported) {
      expect(isSupportedAudioExtension(`D:\\Music\\Track${extension}`)).toBe(false);
    }
  });

  it('keeps cue import support separate from the direct playback dialog list', () => {
    expect(isCueFile('album.cue')).toBe(true);
    expect(SUPPORTED_AUDIO_DIALOG_EXTENSIONS).not.toContain('cue');
  });
});
