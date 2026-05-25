import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  settings: {
    miniPlayerEnabled: false,
    miniPlayerLocked: false,
    miniPlayerBounds: null as { x: number; y: number; width: number; height: number } | null,
  },
}));

vi.mock('electron', () => ({
  BrowserWindow: class {
    static getAllWindows(): unknown[] {
      return [];
    }
  },
  screen: {
    getAllDisplays: vi.fn(() => [
      {
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      },
    ]),
    getDisplayMatching: vi.fn(() => ({
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    })),
    getPrimaryDisplay: vi.fn(() => ({
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    })),
  },
}));

vi.mock('./appSettings', () => ({
  getAppSettings: () => mocks.settings,
  setAppSettings: vi.fn(),
}));

vi.mock('./createMainWindow', () => ({
  createMainWindowWebPreferences: vi.fn(() => ({})),
}));

vi.mock('../diagnostics/DevConsoleService', () => ({
  recordMainRuntimeIssue: vi.fn(),
  recordRendererConsoleMessage: vi.fn(),
}));

describe('mini player window bounds', () => {
  beforeEach(() => {
    mocks.settings.miniPlayerBounds = null;
    vi.resetModules();
  });

  it('defaults to the primary display top-right corner', async () => {
    const { resolveInitialMiniPlayerBounds } = await import('./miniPlayerWindow');

    expect(resolveInitialMiniPlayerBounds()).toEqual({
      x: 1504,
      y: 44,
      width: 388,
      height: 74,
    });
  });

  it('compacts saved bounds from previous default sizes', async () => {
    mocks.settings.miniPlayerBounds = {
      x: 1548,
      y: 44,
      width: 344,
      height: 96,
    };
    const { resolveInitialMiniPlayerBounds } = await import('./miniPlayerWindow');

    expect(resolveInitialMiniPlayerBounds()).toEqual({
      x: 1504,
      y: 44,
      width: 388,
      height: 74,
    });
  });

  it('compacts saved bounds from the oversized mini player', async () => {
    mocks.settings.miniPlayerBounds = {
      x: 1604,
      y: 44,
      width: 288,
      height: 84,
    };
    const { resolveInitialMiniPlayerBounds } = await import('./miniPlayerWindow');

    expect(resolveInitialMiniPlayerBounds()).toEqual({
      x: 1504,
      y: 44,
      width: 388,
      height: 74,
    });
  });

  it('clamps a saved visible position back into the work area', async () => {
    mocks.settings.miniPlayerBounds = {
      x: -80,
      y: 24,
      width: 520,
      height: 116,
    };
    const { resolveInitialMiniPlayerBounds } = await import('./miniPlayerWindow');

    expect(resolveInitialMiniPlayerBounds()).toEqual({
      x: 0,
      y: 24,
      width: 520,
      height: 116,
    });
  });
});
