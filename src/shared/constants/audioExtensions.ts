const audioExtensionValues = [
  '.mp3',
  '.flac',
  '.wav',
  '.m4a',
  '.aac',
  '.ogg',
  '.opus',
  '.wma',
  '.alac',
  '.aiff',
  '.aif',
  '.ape',
  '.wv',
  '.tta',
  '.tak',
  '.caf',
  '.dsf',
  '.dff',
  '.mka',
  '.mkv',
  '.mp4',
  '.mov',
  '.webm',
  '.mp2',
  '.mp1',
  '.mpc',
  '.ofr',
  '.ofs',
  '.spx',
  '.amr',
  '.ac3',
  '.dts',
  '.cue',
] as const;

export const SUPPORTED_AUDIO_EXTENSION_LIST = [...audioExtensionValues];

export const SUPPORTED_AUDIO_EXTENSIONS = new Set<string>(SUPPORTED_AUDIO_EXTENSION_LIST);

// CUE sheets are library import sources for now. Direct single-file playback stays
// conservative until the audio core has explicit cue sheet handling.
export const SUPPORTED_AUDIO_DIALOG_EXTENSIONS = SUPPORTED_AUDIO_EXTENSION_LIST
  .filter((extension) => extension !== '.cue')
  .map((extension) => extension.slice(1));

const getSafeExtension = (filePath: string): string => {
  const normalizedPath = filePath.trim();
  const fileName = normalizedPath.split(/[\\/]/).pop() ?? normalizedPath;
  const dotIndex = fileName.lastIndexOf('.');

  if (dotIndex <= 0 || dotIndex === fileName.length - 1) {
    return '';
  }

  return fileName.slice(dotIndex).toLowerCase();
};

export const isSupportedAudioExtension = (filePath: string): boolean => SUPPORTED_AUDIO_EXTENSIONS.has(getSafeExtension(filePath));

export const isCueFile = (filePath: string): boolean => getSafeExtension(filePath) === '.cue';
