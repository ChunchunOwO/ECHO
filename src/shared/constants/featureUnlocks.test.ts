import { describe, expect, it } from 'vitest';

import {
  downloadFeatureUnlockCode,
  connectDonatorHwidFileName,
  connectDonatorLicenseFileName,
  connectDonatorUnlockPluginId,
  connectDonatorUnlockVersion,
  finalThemeUnlockVersion,
  isDownloadFeatureUnlockCode,
  isFinalThemeUnlockCode,
  proOnlyThemePresets,
} from './featureUnlocks';

describe('feature unlock codes', () => {
  it('accepts the existing download unlock code', () => {
    expect(isDownloadFeatureUnlockCode(downloadFeatureUnlockCode)).toBe(true);
  });

  it('accepts the genshin impact download unlock passphrase', () => {
    expect(isDownloadFeatureUnlockCode('genshin impact')).toBe(true);
    expect(isDownloadFeatureUnlockCode(' Genshin Impact ')).toBe(true);
  });

  it('rejects unknown download unlock input', () => {
    expect(isDownloadFeatureUnlockCode('zimin')).toBe(false);
    expect(isDownloadFeatureUnlockCode('')).toBe(false);
  });

  it('uses the donator plugin marker for Pro theme unlocks and rejects all text keys', () => {
    expect(finalThemeUnlockVersion).toBe('plugin:echo.connect-donator-unlock:pro-themes-v1');
    expect(isFinalThemeUnlockCode('FINAL-8K-7Q4M-H2ND-2026')).toBe(false);
    expect(isFinalThemeUnlockCode('final-8k-7q4m-h2nd-2026')).toBe(false);
    expect(isFinalThemeUnlockCode(' FINAL-8K-7Q4M-H2ND-2026 ')).toBe(false);
    expect(isFinalThemeUnlockCode('finalaudio')).toBe(false);
    expect(isFinalThemeUnlockCode('')).toBe(false);
  });

  it('uses a fixed plugin marker and machine license file for Connect donator unlocks', () => {
    expect(connectDonatorUnlockPluginId).toBe('echo.connect-donator-unlock');
    expect(connectDonatorUnlockVersion).toBe('plugin:echo.connect-donator-unlock:v1');
    expect(connectDonatorHwidFileName).toBe('donator.allowed-hwids.json');
    expect(connectDonatorLicenseFileName).toBe('donator.machine-license.json');
  });

  it('locks premium built-in themes behind the donator unlock', () => {
    expect(proOnlyThemePresets).toEqual(['nyanCat', 'darkSideMoon', 'FINAL']);
  });
});
