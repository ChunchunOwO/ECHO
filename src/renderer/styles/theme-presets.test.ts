import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('theme presets stylesheet', () => {
  it('keeps preset settings backgrounds out of app wallpaper mode', () => {
    const css = readFileSync('src/renderer/styles/theme-presets.css', 'utf8');
    const layoutCss = readFileSync('src/renderer/styles/layout.css', 'utf8');

    expect(css).toContain(
      'html:is([data-theme-custom="true"], [data-theme-preset]:not([data-theme-preset="classic"])) .app-shell:not(.app-shell--wallpaper) .page-surface:has(.settings-page) {',
    );
    expect(css).not.toContain(
      'html:is([data-theme-custom="true"], [data-theme-preset]:not([data-theme-preset="classic"])) .page-surface:has(.settings-page) {\n  background: var(--echo-polish-page-bg), var(--theme-app-bg);',
    );
    expect(css).not.toContain(
      'html:is([data-theme-custom="true"], [data-theme-preset]:not([data-theme-preset="classic"])) .app-shell--wallpaper-ready::before,',
    );
    expect(css).toContain(
      '.app-shell--wallpaper-ready[data-wallpaper-unified-opacity="true"] .page-surface',
    );
    expect(css).toContain(
      '.app-shell--wallpaper-ready:not([data-wallpaper-unified-opacity="true"]):not([data-wallpaper-ui-transparent="true"]) .app-titlebar',
    );
    expect(layoutCss).toContain('.app-wallpaper-layer img,\n.app-wallpaper-layer video {');
    expect(layoutCss).toContain('object-fit: cover;');
    expect(layoutCss).not.toContain('object-fit: contain;');
    expect(layoutCss).toContain('.app-shell--wallpaper-ready[data-wallpaper-unified-opacity="true"]::before');
  });
});
