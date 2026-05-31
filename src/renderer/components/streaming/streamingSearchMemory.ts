import type {
  StreamingAudioQuality,
  StreamingMediaType,
  StreamingProviderName,
  StreamingSearchResult,
} from '../../../shared/types/streaming';

export type StreamingQualityPreference = StreamingAudioQuality | 'max';

export type StreamingSearchMemory = {
  provider: StreamingProviderName;
  quality: StreamingQualityPreference;
  activeTab: StreamingMediaType;
  input: string;
  query: string;
  resultKey: string | null;
  result: StreamingSearchResult | null;
  failedCoverUrls: Record<string, string>;
  scrollTop: number;
};

const initialStreamingSearchMemory: StreamingSearchMemory = {
  provider: 'netease',
  quality: 'lossless',
  activeTab: 'track',
  input: '',
  query: '',
  resultKey: null,
  result: null,
  failedCoverUrls: {},
  scrollTop: 0,
};

const qualityStorageKey = 'echo-next.streaming.quality';

const normalizeStreamingQualityPreference = (value: unknown): StreamingQualityPreference | null =>
  value === 'standard' || value === 'high' || value === 'lossless' || value === 'hires' || value === 'max'
    ? value
    : null;

const readPersistedQuality = (): StreamingQualityPreference | null => {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return null;
    }

    return normalizeStreamingQualityPreference(window.localStorage.getItem(qualityStorageKey));
  } catch {
    return null;
  }
};

const writePersistedQuality = (quality: StreamingQualityPreference): void => {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return;
    }

    window.localStorage.setItem(qualityStorageKey, quality);
  } catch {
    // Quality memory should never block streaming UI changes.
  }
};

let streamingSearchMemory: StreamingSearchMemory = {
  ...initialStreamingSearchMemory,
  quality: readPersistedQuality() ?? initialStreamingSearchMemory.quality,
};

export const readStreamingSearchMemory = (): StreamingSearchMemory => {
  const quality = readPersistedQuality();
  if (quality && quality !== streamingSearchMemory.quality) {
    streamingSearchMemory = {
      ...streamingSearchMemory,
      quality,
    };
  }

  return streamingSearchMemory;
};

export const updateStreamingSearchMemory = (patch: Partial<StreamingSearchMemory>): StreamingSearchMemory => {
  if (patch.quality) {
    writePersistedQuality(patch.quality);
  }

  streamingSearchMemory = {
    ...streamingSearchMemory,
    ...patch,
  };

  return streamingSearchMemory;
};
