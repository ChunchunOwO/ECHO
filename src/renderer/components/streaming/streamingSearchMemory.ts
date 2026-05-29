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
  quality: 'max',
  activeTab: 'track',
  input: '',
  query: '',
  resultKey: null,
  result: null,
  failedCoverUrls: {},
  scrollTop: 0,
};

let streamingSearchMemory: StreamingSearchMemory = { ...initialStreamingSearchMemory };

export const readStreamingSearchMemory = (): StreamingSearchMemory => streamingSearchMemory;

export const updateStreamingSearchMemory = (patch: Partial<StreamingSearchMemory>): StreamingSearchMemory => {
  streamingSearchMemory = {
    ...streamingSearchMemory,
    ...patch,
  };

  return streamingSearchMemory;
};
