import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => process.cwd(),
  },
}));

describe('app settings normalization', () => {
  it('keeps old settings files compatible when coverCacheDir is missing', async () => {
    const { normalizeSettings } = await import('./appSettings');
    const settings = normalizeSettings({
      hideToTrayOnClose: true,
      networkMetadataEnabled: true,
      networkMetadataProviders: ['qq-music'],
      playerVolume: 0.5,
      playbackSpeed: 1.25,
      playbackSpeedMode: 'speed',
    });

    expect(settings.coverCacheDir).toBeNull();
    expect(settings.hideToTrayOnClose).toBe(true);
    expect(settings.networkMetadataProviders).toEqual(['qq-music']);
  });

  it('normalizes an empty coverCacheDir to null', async () => {
    const { normalizeSettings } = await import('./appSettings');

    expect(normalizeSettings({ coverCacheDir: '   ' }).coverCacheDir).toBeNull();
  });

  it('resolves a custom coverCacheDir to an absolute path', async () => {
    const { normalizeSettings } = await import('./appSettings');

    expect(normalizeSettings({ coverCacheDir: 'relative-cover-cache' }).coverCacheDir).toBe(resolve('relative-cover-cache'));
  });
});
