import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hqPlayerConnectDeviceId, type ConnectStartRequest } from '../../shared/types/connect';
import type { LibraryTrack } from '../../shared/types/library';
import type { HqPlayerStatus } from '../../shared/types/hqplayer';

const mocks = vi.hoisted(() => {
  const audioSession = {
    getStatus: vi.fn(),
    pause: vi.fn(),
  };
  const libraryService = {
    getTrack: vi.fn(),
    resolveCoverAsset: vi.fn(),
  };

  return {
    audioSession,
    libraryService,
  };
});

vi.mock('../audio/AudioSession', () => ({
  getAudioSession: () => mocks.audioSession,
}));

vi.mock('../library/LibraryService', () => ({
  getLibraryService: () => mocks.libraryService,
}));

const localTrack: LibraryTrack = {
  id: 'track-1',
  path: 'D:\\Music\\song.flac',
  title: 'Song',
  artist: 'Artist',
  album: 'Album',
  albumArtist: 'Album Artist',
  trackNo: 1,
  discNo: 1,
  year: 2026,
  genre: null,
  duration: 180,
  codec: 'flac',
  sampleRate: 44100,
  bitDepth: 16,
  bitrate: 900000,
  coverId: null,
  coverThumb: null,
  fieldSources: {},
};

const hqStatus = (state: HqPlayerStatus['state'] = 'disabled'): HqPlayerStatus => ({
  enabled: state !== 'disabled',
  state,
  endpoint: {
    connectionMode: 'localDesktop',
    host: '127.0.0.1',
    port: 4321,
  },
  mediaServerEnabled: false,
  defaultPlaybackBackend: 'ask',
  profileName: null,
  lastCheckedAt: null,
  lastError: null,
});

const createHqPlayerService = () => ({
  getSettings: vi.fn().mockReturnValue({
    enabled: false,
    connectionMode: 'localDesktop',
    host: '127.0.0.1',
    port: 4321,
    executablePath: null,
    allowLaunch: false,
    mediaServerEnabled: false,
    mediaServerPort: null,
    defaultPlaybackBackend: 'ask',
    profileName: null,
  }),
  setSettings: vi.fn().mockImplementation((patch) => ({
    enabled: true,
    connectionMode: 'localDesktop',
    host: '127.0.0.1',
    port: 4321,
    executablePath: null,
    allowLaunch: false,
    mediaServerEnabled: false,
    mediaServerPort: null,
    defaultPlaybackBackend: 'ask',
    profileName: null,
    ...patch,
  })),
  getStatus: vi.fn().mockReturnValue(hqStatus()),
  testConnection: vi.fn().mockResolvedValue({
    ok: true,
    state: 'available',
    endpoint: {
      connectionMode: 'localDesktop',
      host: '127.0.0.1',
      port: 4321,
    },
    elapsedMs: 8,
    checkedAt: '2026-05-21T01:00:00.000Z',
    error: null,
  }),
  createPlaybackHandoff: vi.fn().mockResolvedValue({
    state: 'ready',
    reason: null,
    control: {
      state: 'prepared',
      reason: null,
    },
  }),
  sendLastPlaybackControl: vi.fn().mockResolvedValue({
    state: 'sent',
    reason: null,
    message: null,
  }),
});

describe('ConnectService HQPlayer output device', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.audioSession.getStatus.mockReturnValue({
      state: 'playing',
      currentTrackId: localTrack.id,
      currentFilePath: localTrack.path,
      positionSeconds: 7,
    });
    mocks.audioSession.pause.mockResolvedValue({});
    mocks.libraryService.getTrack.mockReturnValue(localTrack);
    mocks.libraryService.resolveCoverAsset.mockReturnValue(null);
  });

  it('lists HQPlayer as a synthetic Connect output device', async () => {
    const { ConnectService } = await import('./ConnectService');
    const hqPlayer = createHqPlayerService();
    const service = new ConnectService(hqPlayer);

    expect(service.listDevices()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: hqPlayerConnectDeviceId,
        name: 'HQPlayer Desktop',
        protocol: 'hqplayer',
        capabilities: expect.objectContaining({
          canPlay: false,
          canPause: false,
          canStop: false,
          canSetVolume: false,
        }),
      }),
    ]));
  });

  it('surfaces the last HQPlayer control probe on the synthetic device', async () => {
    const { ConnectService } = await import('./ConnectService');
    const hqPlayer = createHqPlayerService();
    hqPlayer.getStatus.mockReturnValue({
      ...hqStatus('available'),
      lastCheckedAt: '2026-05-21T01:00:00.000Z',
      controlInfo: {
        name: 'Living Room',
        product: 'HQPlayer Desktop',
        version: '5.17.2',
        platform: 'Windows',
        engine: '5.29.2',
        receivedAt: '2026-05-21T01:00:01.000Z',
      },
    });
    const service = new ConnectService(hqPlayer);

    expect(service.listDevices()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: hqPlayerConnectDeviceId,
        model: 'HQPlayer Desktop 5.17.2',
        lastSeenAt: '2026-05-21T01:00:01.000Z',
      }),
    ]));
  });

  it('connects HQPlayer through the official control sender and pauses ECHO playback', async () => {
    const { ConnectService } = await import('./ConnectService');
    const hqPlayer = createHqPlayerService();
    const service = new ConnectService(hqPlayer);
    const request: ConnectStartRequest = {
      deviceId: hqPlayerConnectDeviceId,
      track: localTrack,
      filePath: localTrack.path,
      positionSeconds: 7,
    };

    await expect(service.connect(request)).resolves.toMatchObject({
      deviceId: hqPlayerConnectDeviceId,
      protocol: 'hqplayer',
      state: 'playing',
      currentTrackId: localTrack.id,
      positionSeconds: 7,
    });

    expect(hqPlayer.setSettings).toHaveBeenCalledWith(expect.objectContaining({
      enabled: true,
      connectionMode: 'localDesktop',
      host: '127.0.0.1',
      port: 4321,
    }));
    expect(hqPlayer.testConnection).toHaveBeenCalledOnce();
    expect(hqPlayer.createPlaybackHandoff).toHaveBeenCalledWith(expect.objectContaining({
      confirmed: true,
      startSeconds: 7,
      item: expect.objectContaining({
        mediaType: 'local',
        trackId: localTrack.id,
        path: localTrack.path,
      }),
    }));
    expect(hqPlayer.sendLastPlaybackControl).toHaveBeenCalledOnce();
    expect(mocks.audioSession.pause).toHaveBeenCalledOnce();
  });

  it('keeps HQPlayer connection failures visible on the Connect session', async () => {
    const { ConnectService } = await import('./ConnectService');
    const hqPlayer = createHqPlayerService();
    hqPlayer.testConnection.mockResolvedValueOnce({
      ok: false,
      state: 'unavailable',
      endpoint: {
        connectionMode: 'localDesktop',
        host: '127.0.0.1',
        port: 4321,
      },
      elapsedMs: 12,
      checkedAt: '2026-05-21T01:00:00.000Z',
      error: 'hqplayer_connection_refused',
    });
    const service = new ConnectService(hqPlayer);

    await expect(service.connect({
      deviceId: hqPlayerConnectDeviceId,
      track: localTrack,
      filePath: localTrack.path,
    })).rejects.toThrow('hqplayer_connection_refused');

    expect(service.getStatus()).toMatchObject({
      deviceId: hqPlayerConnectDeviceId,
      protocol: 'hqplayer',
      state: 'error',
      error: 'hqplayer_connection_refused',
    });
    expect(hqPlayer.sendLastPlaybackControl).not.toHaveBeenCalled();
  });
});
