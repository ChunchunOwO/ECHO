import type { EqBand } from '../../../shared/types/eq';

type EqBandSliderProps = {
  band: EqBand;
  index: number;
  onChange: (index: number, gainDb: number) => void;
  onCommit: (index: number, gainDb: number) => void;
};

const formatFrequency = (frequencyHz: number): string =>
  frequencyHz >= 1000 ? `${frequencyHz / 1000}k` : String(frequencyHz);

export const EqBandSlider = ({ band, index, onChange, onCommit }: EqBandSliderProps): JSX.Element => {
  const value = Number(band.gainDb.toFixed(1));

  return (
    <label className="eq-band-slider">
      <span className="eq-band-gain">{value > 0 ? `+${value}` : value.toString()}</span>
      <input
        aria-label={`${formatFrequency(band.frequencyHz)} Hz gain`}
        type="range"
        min="-12"
        max="12"
        step="0.1"
        value={value}
        onChange={(event) => onChange(index, Number(event.currentTarget.value))}
        onPointerUp={(event) => onCommit(index, Number(event.currentTarget.value))}
        onKeyUp={(event) => onCommit(index, Number(event.currentTarget.value))}
      />
      <span className="eq-band-frequency">{formatFrequency(band.frequencyHz)}</span>
    </label>
  );
};
