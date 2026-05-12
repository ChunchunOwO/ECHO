import { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCcw, Save, SlidersHorizontal, Trash2 } from 'lucide-react';
import type { AudioStatus } from '../../../shared/types/audio';
import type { EqPreset, EqState } from '../../../shared/types/eq';
import { eqMaxFrequencyHz, eqMinFrequencyHz } from '../../../shared/types/eq';
import { getEqBridge } from '../../utils/echoBridge';
import { EqCurveView } from './EqCurveView';
import { EqPresetSelector } from './EqPresetSelector';

type EqPanelProps = {
  audioStatus: AudioStatus | null;
  onAudioStatusRefresh?: () => void;
};

const fallbackState: EqState = {
  enabled: false,
  preampDb: 0,
  presetId: 'flat',
  presetName: 'Flat',
  clippingRisk: false,
  bands: [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].map((frequencyHz) => ({
    frequencyHz,
    gainDb: 0,
    q: 1,
  })),
};

const formatFrequency = (frequencyHz: number): string =>
  frequencyHz >= 1000 ? `${frequencyHz / 1000} kHz` : `${frequencyHz} Hz`;

const formatGain = (gainDb: number): string => `${gainDb > 0 ? '+' : ''}${gainDb.toFixed(1)} dB`;
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

export const EqPanel = ({ audioStatus, onAudioStatusRefresh }: EqPanelProps): JSX.Element => {
  const [state, setState] = useState<EqState>(fallbackState);
  const [presets, setPresets] = useState<EqPreset[]>([]);
  const [saveName, setSaveName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [selectedBandIndex, setSelectedBandIndex] = useState(0);
  const debounceTimers = useRef<Record<number, number>>({});
  const frequencyDebounceTimers = useRef<Record<number, number>>({});

  const selectedBand = state.bands[selectedBandIndex] ?? state.bands[0];
  const selectedPresetReadonly = presets.find((preset) => preset.id === state.presetId)?.readonly ?? true;

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const eq = getEqBridge();

      if (!eq) {
        setPresets([]);
        setError('Desktop bridge unavailable. Open ECHO Next in Electron to control EQ.');
        return;
      }

      const [nextState, nextPresets] = await Promise.all([eq.getState(), eq.listPresets()]);
      setState(nextState);
      setPresets(nextPresets);
      setError(null);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const commitState = useCallback(
    (nextState: EqState): void => {
      setState(nextState);
      onAudioStatusRefresh?.();
    },
    [onAudioStatusRefresh],
  );

  const setEnabled = (enabled: boolean): void => {
    const eq = getEqBridge();
    setState((current) => ({ ...current, enabled }));

    if (!eq) {
      setError('Desktop bridge unavailable. Open ECHO Next in Electron to control EQ.');
      return;
    }

    void eq.setEnabled(enabled).then(commitState).catch((toggleError: unknown) => {
      setError(toggleError instanceof Error ? toggleError.message : String(toggleError));
    });
  };

  const sendBandGain = useCallback(
    (band: number, gainDb: number): void => {
      const eq = getEqBridge();

      if (!eq) {
        setError('Desktop bridge unavailable. Open ECHO Next in Electron to control EQ.');
        return;
      }

      void eq.setBandGain({ band, gainDb }).then(commitState).catch((bandError: unknown) => {
        setError(bandError instanceof Error ? bandError.message : String(bandError));
      });
    },
    [commitState],
  );

  const handleBandChange = (band: number, gainDb: number): void => {
    setSelectedBandIndex(band);
    setState((current) => ({
      ...current,
      presetId: 'custom',
      presetName: 'Custom',
      bands: current.bands.map((item, index) => (index === band ? { ...item, gainDb } : item)),
    }));

    window.clearTimeout(debounceTimers.current[band]);
    debounceTimers.current[band] = window.setTimeout(() => sendBandGain(band, gainDb), 45);
  };

  const handleBandCommit = (band: number, gainDb: number): void => {
    setSelectedBandIndex(band);
    window.clearTimeout(debounceTimers.current[band]);
    sendBandGain(band, gainDb);
  };

  const sendBandFrequency = useCallback(
    (band: number, frequencyHz: number): void => {
      const eq = getEqBridge();

      if (!eq) {
        setError('Desktop bridge unavailable. Open ECHO Next in Electron to control EQ.');
        return;
      }

      void eq.setBandFrequency({ band, frequencyHz }).then(commitState).catch((bandError: unknown) => {
        setError(bandError instanceof Error ? bandError.message : String(bandError));
      });
    },
    [commitState],
  );

  const handleBandFrequencyChange = (band: number, frequencyHz: number): void => {
    const safeFrequencyHz = clamp(Number(frequencyHz), eqMinFrequencyHz, eqMaxFrequencyHz);
    setSelectedBandIndex(band);
    setState((current) => ({
      ...current,
      presetId: 'custom',
      presetName: 'Custom',
      bands: current.bands.map((item, index) => (index === band ? { ...item, frequencyHz: safeFrequencyHz } : item)),
    }));

    window.clearTimeout(frequencyDebounceTimers.current[band]);
    frequencyDebounceTimers.current[band] = window.setTimeout(() => sendBandFrequency(band, safeFrequencyHz), 45);
  };

  const handleBandFrequencyCommit = (band: number, frequencyHz: number): void => {
    const safeFrequencyHz = clamp(Number(frequencyHz), eqMinFrequencyHz, eqMaxFrequencyHz);
    setSelectedBandIndex(band);
    window.clearTimeout(frequencyDebounceTimers.current[band]);
    sendBandFrequency(band, safeFrequencyHz);
  };

  const handlePreampChange = (preampDb: number): void => {
    const eq = getEqBridge();
    setState((current) => ({ ...current, preampDb, presetId: 'custom', presetName: 'Custom' }));

    if (!eq) {
      setError('Desktop bridge unavailable. Open ECHO Next in Electron to control EQ.');
      return;
    }

    void eq.setPreamp(preampDb).then(commitState).catch((preampError: unknown) => {
      setError(preampError instanceof Error ? preampError.message : String(preampError));
    });
  };

  const setPreset = (presetId: string): void => {
    const eq = getEqBridge();

    if (!eq) {
      setError('Desktop bridge unavailable. Open ECHO Next in Electron to control EQ.');
      return;
    }

    void eq.setPreset(presetId).then(commitState).catch((presetError: unknown) => {
      setError(presetError instanceof Error ? presetError.message : String(presetError));
    });
  };

  const reset = (): void => {
    const eq = getEqBridge();

    if (!eq) {
      setState(fallbackState);
      setError('Desktop bridge unavailable. Open ECHO Next in Electron to control EQ.');
      return;
    }

    void eq.reset().then(commitState).catch((resetError: unknown) => {
      setError(resetError instanceof Error ? resetError.message : String(resetError));
    });
  };

  const savePreset = async (): Promise<void> => {
    if (!saveName.trim()) {
      setError('请输入预设名称');
      return;
    }

    try {
      const eq = getEqBridge();

      if (!eq) {
        setError('Desktop bridge unavailable. Open ECHO Next in Electron to save EQ presets.');
        return;
      }

      await eq.savePreset({
        name: saveName,
        preampDb: state.preampDb,
        bands: state.bands,
      });
      setSaveName('');
      setPresets(await eq.listPresets());
      setError(null);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    }
  };

  const deletePreset = async (): Promise<void> => {
    try {
      const eq = getEqBridge();

      if (!eq) {
        setError('Desktop bridge unavailable. Open ECHO Next in Electron to delete EQ presets.');
        return;
      }

      setPresets(await eq.deletePreset(state.presetId));
      await reset();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    }
  };

  const bitPerfectText =
    state.enabled || audioStatus?.dspActive
      ? 'EQ 已启用，DSP 正在工作，当前输出不再是 bit-perfect。'
      : 'EQ 已旁路，满足采样率与输出条件时可恢复 bit-perfect。';

  return (
    <section className="eq-panel" aria-label="ECHO Next EQ panel" data-enabled={state.enabled}>
      <header className="eq-compact-header">
        <div className="eq-title-block">
          <span className="eq-title-icon">
            <SlidersHorizontal size={18} />
          </span>
          <div>
            <h2>参数化 EQ</h2>
            <p>10-band graphic engine</p>
          </div>
          <strong>{state.enabled ? '已启用' : '旁路'}</strong>
        </div>

        <div className="eq-compact-actions">
          <label className="eq-enable-pill">
            <input type="checkbox" checked={state.enabled} onChange={(event) => setEnabled(event.currentTarget.checked)} />
            <span>{state.enabled ? 'On' : 'Bypass'}</span>
          </label>
          <EqPresetSelector presets={presets} value={state.presetId} onChange={setPreset} />
          <button className="eq-icon-action" type="button" aria-label="重置 EQ" title="重置 EQ" onClick={reset}>
            <RotateCcw size={15} />
          </button>
        </div>
      </header>

      <div className="eq-compact-editor">
        <aside className="eq-preamp-strip">
          <span>Preamp</span>
          <strong>{formatGain(state.preampDb)}</strong>
          <input
            aria-label="EQ preamp"
            type="range"
            min="-12"
            max="6"
            step="0.1"
            value={state.preampDb}
            onChange={(event) => handlePreampChange(Number(event.currentTarget.value))}
          />
        </aside>

        <div className="eq-curve-column">
          <EqCurveView
            bands={state.bands}
            enabled={state.enabled}
            selectedBandIndex={selectedBandIndex}
            onBandSelect={setSelectedBandIndex}
            onBandChange={handleBandChange}
            onBandCommit={handleBandCommit}
            onBandFrequencyChange={handleBandFrequencyChange}
            onBandFrequencyCommit={handleBandFrequencyCommit}
          />

          <div className="eq-band-compact">
            <button className="eq-band-name" type="button">
              Band {selectedBandIndex + 1}
              <strong>{selectedBand ? formatFrequency(selectedBand.frequencyHz) : 'n/a'}</strong>
            </button>
            <label>
              <span>Freq</span>
              <input
                aria-label="Selected EQ band frequency"
                type="number"
                min={eqMinFrequencyHz}
                max={eqMaxFrequencyHz}
                step="1"
                value={Math.round(selectedBand?.frequencyHz ?? 0)}
                onChange={(event) => handleBandFrequencyChange(selectedBandIndex, Number(event.currentTarget.value))}
                onBlur={(event) => handleBandFrequencyCommit(selectedBandIndex, Number(event.currentTarget.value))}
              />
              <em>Hz</em>
            </label>
            <label>
              <span>Gain</span>
              <input
                aria-label="Selected EQ band gain"
                type="number"
                min="-12"
                max="12"
                step="0.1"
                value={selectedBand?.gainDb ?? 0}
                onChange={(event) => handleBandChange(selectedBandIndex, Number(event.currentTarget.value))}
                onBlur={(event) => handleBandCommit(selectedBandIndex, Number(event.currentTarget.value))}
              />
              <em>dB</em>
            </label>
            <label>
              <span>Q</span>
              <input value={selectedBand?.q.toFixed(2) ?? '1.00'} readOnly />
            </label>
            <span className="eq-param-chip">Bell</span>
            <span className="eq-param-chip">L/R linked</span>
            <span className="eq-param-chip">Minimum phase</span>
            <button className="eq-soft-button" type="button" onClick={() => handleBandCommit(selectedBandIndex, 0)}>
              归零
            </button>
          </div>
        </div>
      </div>

      <div className="eq-status-line" data-risk={state.clippingRisk || audioStatus?.clippingRisk}>
        <strong>{state.clippingRisk || audioStatus?.clippingRisk ? 'Headroom' : 'Signal'}</strong>
        <span>{state.clippingRisk || audioStatus?.clippingRisk ? '有削波风险，建议降低前级或减少提升频段。' : bitPerfectText}</span>
      </div>

      <footer className="eq-preset-tools">
        <input
          aria-label="Preset name"
          value={saveName}
          onChange={(event) => setSaveName(event.currentTarget.value)}
          placeholder="保存为新预设"
        />
        <button type="button" onClick={() => void savePreset()}>
          <Save size={15} />
          保存
        </button>
        {!selectedPresetReadonly ? (
          <button type="button" onClick={() => void deletePreset()}>
            <Trash2 size={15} />
            删除
          </button>
        ) : null}
      </footer>
      {error ? <p className="eq-panel-error">{error}</p> : null}
    </section>
  );
};
