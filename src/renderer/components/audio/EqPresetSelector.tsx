import { ChevronDown } from 'lucide-react';
import type { EqPreset } from '../../../shared/types/eq';

type EqPresetSelectorProps = {
  presets: EqPreset[];
  value: string;
  onChange: (presetId: string) => void;
};

export const EqPresetSelector = ({ presets, value, onChange }: EqPresetSelectorProps): JSX.Element => (
  <label className="eq-preset-selector">
    <select aria-label="EQ preset" value={value} onChange={(event) => onChange(event.currentTarget.value)}>
      {presets.map((preset) => (
        <option value={preset.id} key={preset.id}>
          {preset.name}
        </option>
      ))}
      {value === 'custom' ? <option value="custom">Custom</option> : null}
    </select>
    <ChevronDown size={16} aria-hidden="true" />
  </label>
);
