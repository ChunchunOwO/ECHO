// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { LibraryTrack } from '../../../shared/types/library';
import { pluginTrackActionDrawerEvent } from './PluginTrackActionDrawer';
import { TrackContextMenu } from './TrackContextMenu';

vi.mock('../../i18n/I18nProvider', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

const track: LibraryTrack = {
  id: 'track-1',
  path: 'D:\\Music\\track-1.flac',
  title: 'Track One',
  artist: 'Artist',
  album: 'Album',
  albumArtist: 'Artist',
  trackNo: 1,
  discNo: 1,
  year: 2026,
  genre: null,
  duration: 180,
  codec: 'FLAC',
  sampleRate: 96_000,
  bitDepth: 24,
  bitrate: 1_200_000,
  coverId: null,
  coverThumb: null,
  embeddedMetadataStatus: 'present',
  embeddedCoverStatus: 'missing',
  networkMetadataStatus: 'none',
  fieldSources: {},
};

describe('TrackContextMenu plugin track actions', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, 'echo');
  });

  it('opens a plugin-provided track action from the right-click menu', async () => {
    const onAction = vi.fn();
    const onClose = vi.fn();
    const openHandler = vi.fn();
    Object.defineProperty(window, 'echo', {
      configurable: true,
      value: {
        plugins: {
          list: vi.fn(async () => ({
            directory: 'D:\\Echo\\Plugins',
            plugins: [{
              id: 'echo.audio-authenticity',
              enabled: true,
              contributes: {
                trackContextMenus: [{ id: 'audio-authenticity', title: '音频可信度', commandId: 'analyze-track', localOnly: true }],
              },
            }],
          })),
        },
      },
    });
    window.addEventListener(pluginTrackActionDrawerEvent, openHandler);

    render(<TrackContextMenu track={track} position={{ x: 20, y: 24 }} onAction={onAction} onClose={onClose} />);
    fireEvent.click(await screen.findByRole('menuitem', { name: '音频可信度' }));

    expect(openHandler).toHaveBeenCalledTimes(1);
    expect((openHandler.mock.calls[0][0] as CustomEvent).detail).toMatchObject({
      pluginId: 'echo.audio-authenticity',
      commandId: 'analyze-track',
      title: '音频可信度',
      track: { id: 'track-1' },
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onAction).not.toHaveBeenCalled();

    window.removeEventListener(pluginTrackActionDrawerEvent, openHandler);
  });
});
