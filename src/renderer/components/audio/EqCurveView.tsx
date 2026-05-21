import { useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { EqBand } from '../../../shared/types/eq';
import { eqFrequenciesHz, eqMaxFrequencyHz, eqMaxGainDb, eqMinFrequencyHz, eqMinGainDb } from '../../../shared/types/eq';
import { useI18n } from '../../i18n/I18nProvider';
import { clamp, computeEqCurvePoints, formatDb, formatFrequencyLabel, resolveBandFrequency } from './eqPanelUtils';

type EqCurveViewProps = {
  bands: EqBand[];
  enabled: boolean;
  frequencyUnlocked: boolean;
  selectedBandIndex: number;
  onBandSelect: (index: number) => void;
  onBandChange: (index: number, gainDb: number) => void;
  onBandCommit: (index: number, gainDb: number) => void;
  onBandFrequencyChange: (index: number, frequencyHz: number) => void;
  onBandFrequencyCommit: (index: number, frequencyHz: number) => void;
};

type DragPoint = {
  rawFrequencyHz: number;
  frequencyHz: number;
  gainDb: number;
};

const width = 920;
const height = 360;
const paddingLeft = 62;
const paddingRight = 56;
const paddingTop = 30;
const paddingBottom = 42;
const plotWidth = width - paddingLeft - paddingRight;
const plotHeight = height - paddingTop - paddingBottom;
const axisGains = [12, 9, 6, 3, 0, -3, -6, -9, -12];

const toSvgPoint = (point: { x: number; y: number }): { x: number; y: number } => ({
  x: paddingLeft + point.x * plotWidth,
  y: paddingTop + point.y * plotHeight,
});

const bandToSvgPoint = (band: EqBand): { x: number; y: number } => toSvgPoint(computeEqCurvePoints([band])[0]);

const gainToY = (gainDb: number): number => {
  const normalized = (gainDb - eqMinGainDb) / (eqMaxGainDb - eqMinGainDb);
  return paddingTop + (1 - normalized) * plotHeight;
};

const yToGain = (y: number): number => {
  const normalized = 1 - clamp((y - paddingTop) / plotHeight, 0, 1);
  return Math.round((eqMinGainDb + normalized * (eqMaxGainDb - eqMinGainDb)) * 10) / 10;
};

const xToFrequency = (x: number): number => {
  const minLog = Math.log10(eqMinFrequencyHz);
  const maxLog = Math.log10(eqMaxFrequencyHz);
  const normalized = clamp((x - paddingLeft) / plotWidth, 0, 1);
  const frequencyHz = 10 ** (minLog + normalized * (maxLog - minLog));

  return frequencyHz < 1000 ? Math.round(frequencyHz) : Math.round(frequencyHz / 10) * 10;
};

const clientPointToSvgPoint = (
  svg: SVGSVGElement | null,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null => {
  if (!svg) {
    return null;
  }

  const screenMatrix = svg.getScreenCTM?.();

  if (!screenMatrix) {
    return null;
  }

  const inverseMatrix = screenMatrix.inverse();
  const svgPoint = svg.createSVGPoint?.();

  if (svgPoint) {
    svgPoint.x = clientX;
    svgPoint.y = clientY;
    const transformedPoint = svgPoint.matrixTransform(inverseMatrix);
    return { x: transformedPoint.x, y: transformedPoint.y };
  }

  if (typeof DOMPoint === 'function') {
    const transformedPoint = new DOMPoint(clientX, clientY).matrixTransform(inverseMatrix);
    return { x: transformedPoint.x, y: transformedPoint.y };
  }

  return null;
};

const makeSmoothPath = (points: Array<{ x: number; y: number }>): string => {
  if (points.length === 0) {
    return '';
  }

  if (points.length === 1) {
    return `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  }

  const commands = [`M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`];

  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    const previous = points[index - 1] ?? current;
    const afterNext = points[index + 2] ?? next;
    const cp1x = current.x + (next.x - previous.x) / 6;
    const cp1y = current.y + (next.y - previous.y) / 6;
    const cp2x = next.x - (afterNext.x - current.x) / 6;
    const cp2y = next.y - (afterNext.y - current.y) / 6;
    commands.push(`C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${next.x.toFixed(1)} ${next.y.toFixed(1)}`);
  }

  return commands.join(' ');
};

export const EqCurveView = ({
  bands,
  enabled,
  frequencyUnlocked,
  selectedBandIndex,
  onBandSelect,
  onBandChange,
  onBandCommit,
  onBandFrequencyChange,
  onBandFrequencyCommit,
}: EqCurveViewProps): JSX.Element => {
  const { t } = useI18n();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [activeBand, setActiveBand] = useState<number | null>(null);
  const [hoverBand, setHoverBand] = useState<number | null>(null);
  const [fineEdit, setFineEdit] = useState(false);
  const [dragPreview, setDragPreview] = useState<{ index: number; band: EqBand } | null>(null);
  const displayBands = dragPreview
    ? bands.map((band, index) => (index === dragPreview.index ? dragPreview.band : band))
    : bands;
  const points = computeEqCurvePoints(displayBands).map(toSvgPoint);
  const path = makeSmoothPath(points);
  const zeroY = gainToY(0);
  const fillPath = path ? `${path} L ${paddingLeft + plotWidth} ${zeroY.toFixed(1)} L ${paddingLeft} ${zeroY.toFixed(1)} Z` : '';
  const readoutBandIndex = activeBand ?? hoverBand ?? selectedBandIndex;
  const selectedBand = displayBands[readoutBandIndex];
  const selectedPoint = selectedBand ? bandToSvgPoint(selectedBand) : null;
  const readoutModeLabel = fineEdit
    ? t('settings.eq.curve.fineEdit')
    : frequencyUnlocked
      ? t('settings.eq.curve.freeFrequency')
      : null;

  const quantizeGain = (gainDb: number, fine: boolean): number => {
    const step = fine ? 0.1 : 0.5;
    return Math.round(gainDb / step) * step;
  };

  const pointFromEvent = (event: ReactPointerEvent<SVGElement>): DragPoint => {
    const svgPoint = clientPointToSvgPoint(svgRef.current, event.clientX, event.clientY);
    const rect = svgRef.current?.getBoundingClientRect();
    const x = svgPoint?.x ?? (rect && rect.width > 0 ? (event.clientX - rect.left) * (width / rect.width) : paddingLeft);
    const y = svgPoint?.y ?? (rect && rect.height > 0 ? (event.clientY - rect.top) * (height / rect.height) : zeroY);
    const rawFrequencyHz = xToFrequency(x);
    setFineEdit(event.shiftKey);
    return {
      rawFrequencyHz,
      frequencyHz: resolveBandFrequency(rawFrequencyHz, frequencyUnlocked),
      gainDb: quantizeGain(yToGain(y), event.shiftKey),
    };
  };

  const updateBandFromEvent = (event: ReactPointerEvent<SVGElement>, index: number): DragPoint => {
    const point = pointFromEvent(event);
    const previewFrequencyHz = frequencyUnlocked ? point.frequencyHz : point.rawFrequencyHz;
    setDragPreview({
      index,
      band: {
        ...(bands[index] ?? { frequencyHz: point.frequencyHz, gainDb: 0, q: 1, filterType: 'peaking' as const, enabled: true }),
        frequencyHz: previewFrequencyHz,
        gainDb: point.gainDb,
      },
    });
    onBandChange(index, point.gainDb);
    if (frequencyUnlocked && point.frequencyHz !== bands[index]?.frequencyHz) {
      onBandFrequencyChange(index, point.frequencyHz);
    }
    return point;
  };

  const handlePointerDown = (event: ReactPointerEvent<SVGGElement>, index: number): void => {
    event.preventDefault();
    svgRef.current?.setPointerCapture?.(event.pointerId);
    setActiveBand(index);
    onBandSelect(index);
    updateBandFromEvent(event, index);
  };

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (activeBand === null) {
      return;
    }

    updateBandFromEvent(event, activeBand);
  };

  const handlePointerUp = (event: ReactPointerEvent<SVGSVGElement | SVGGElement>): void => {
    if (activeBand === null) {
      return;
    }

    const point = updateBandFromEvent(event, activeBand);
    onBandCommit(activeBand, point.gainDb);
    if (point.frequencyHz !== bands[activeBand]?.frequencyHz) {
      onBandFrequencyCommit(activeBand, point.frequencyHz);
    }
    const svg = svgRef.current;
    if (svg?.hasPointerCapture?.(event.pointerId)) {
      svg.releasePointerCapture(event.pointerId);
    }
    setActiveBand(null);
    setDragPreview(null);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<SVGGElement>, index: number): void => {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
      return;
    }

    event.preventDefault();
    onBandSelect(index);

    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const delta = event.shiftKey ? 0.1 : 0.5;
      const gainDb = Math.round(clamp(bands[index].gainDb + (event.key === 'ArrowUp' ? delta : -delta), eqMinGainDb, eqMaxGainDb) * 10) / 10;
      onBandChange(index, gainDb);
      onBandCommit(index, gainDb);
      return;
    }

    if (!frequencyUnlocked) {
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      const currentFrequency = bands[index].frequencyHz;
      const currentIndex = eqFrequenciesHz.reduce((nearestIndex, candidate, candidateIndex) => {
        const currentDistance = Math.abs(Math.log2(currentFrequency / eqFrequenciesHz[nearestIndex]));
        const nextDistance = Math.abs(Math.log2(currentFrequency / candidate));
        return nextDistance < currentDistance ? candidateIndex : nearestIndex;
      }, 0);
      const frequencyHz = eqFrequenciesHz[clamp(currentIndex + direction, 0, eqFrequenciesHz.length - 1)] ?? currentFrequency;
      onBandFrequencyChange(index, frequencyHz);
      onBandFrequencyCommit(index, frequencyHz);
      return;
    }

    const ratio = event.shiftKey ? 2 ** (1 / 3) : 2 ** (1 / 12);
    const frequencyHz = Math.round(clamp(
      event.key === 'ArrowRight' ? bands[index].frequencyHz * ratio : bands[index].frequencyHz / ratio,
      eqMinFrequencyHz,
      eqMaxFrequencyHz,
    ));
    onBandFrequencyChange(index, frequencyHz);
    onBandFrequencyCommit(index, frequencyHz);
  };

  return (
    <div className="eq-curve-shell" data-enabled={enabled}>
      <svg
        className="eq-curve-view"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={t('settings.eq.curve.aria')}
        ref={svgRef}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <defs>
          <linearGradient id="eqCurveStroke" x1="0%" x2="100%" y1="0%" y2="0%">
            <stop offset="0%" stopColor="#264a63" />
            <stop offset="50%" stopColor="#2e7168" />
            <stop offset="100%" stopColor="#8a6235" />
          </linearGradient>
          <linearGradient id="eqCurveFill" x1="0%" x2="0%" y1="0%" y2="100%">
            <stop offset="0%" stopColor="rgba(46, 113, 104, 0.18)" />
            <stop offset="100%" stopColor="rgba(46, 113, 104, 0.03)" />
          </linearGradient>
        </defs>

        {axisGains.map((gainDb) => {
          const y = gainToY(gainDb);
          return (
            <g key={gainDb}>
              <line className="eq-grid-line" data-major={gainDb % 6 === 0} x1={paddingLeft} x2={paddingLeft + plotWidth} y1={y} y2={y} />
              <text className="eq-y-label" x={width - paddingRight + 10} y={y + 4}>
                {`${gainDb > 0 ? '+' : ''}${gainDb} dB`}
              </text>
            </g>
          );
        })}

        <line className="eq-zero-line" x1={paddingLeft} x2={paddingLeft + plotWidth} y1={zeroY} y2={zeroY} />
        <path className="eq-curve-fill" d={fillPath} />
        <path className="eq-curve-stroke" d={path} />
        <path className="eq-curve-hit-area" d={path} />

        {displayBands.map((band, index) => {
          const point = bandToSvgPoint(band);
          const selected = selectedBandIndex === index;
          return (
            <g
              className="eq-curve-node-group"
              aria-label={t('settings.eq.curve.dragBand', { frequency: formatFrequencyLabel(band.frequencyHz) })}
              data-active={selected}
              data-bypassed={band.enabled === false}
              data-dragging={activeBand === index}
              data-testid={`eq-curve-node-${index}`}
              key={`${band.frequencyHz}-${index}`}
              tabIndex={0}
              transform={`translate(${point.x.toFixed(1)} ${point.y.toFixed(1)})`}
              onClick={() => onBandSelect(index)}
              onFocus={() => onBandSelect(index)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              onPointerEnter={() => setHoverBand(index)}
              onPointerLeave={() => setHoverBand((current) => (current === index ? null : current))}
              onPointerDown={(event) => handlePointerDown(event, index)}
            >
              <circle className="eq-curve-node-hit" r="16" />
              <circle className="eq-curve-node" r={selected ? 9 : 7.5} />
              <text className="eq-curve-node-number" y="3.5">
                {formatFrequencyLabel(band.frequencyHz)}
              </text>
            </g>
          );
        })}

        {displayBands.map((band, index) => {
          const point = bandToSvgPoint(band);
          return (
            <text className="eq-x-label" x={point.x} y={height - 14} key={`${band.frequencyHz}-${index}-label`}>
              {formatFrequencyLabel(band.frequencyHz)}
            </text>
          );
        })}

        {selectedBand && selectedPoint ? (
          <g className="eq-selected-readout" transform={`translate(${selectedPoint.x.toFixed(1)} ${(selectedPoint.y - 22).toFixed(1)})`}>
            <text className="eq-selected-readout-frequency" y="-4">
              {formatFrequencyLabel(selectedBand.frequencyHz)}
            </text>
            <text className="eq-selected-readout-gain" x="28" y="16">
              {formatDb(selectedBand.gainDb)}
            </text>
            {readoutModeLabel ? (
              <text className="eq-selected-readout-mode" x="-28" y="16">
                {readoutModeLabel}
              </text>
            ) : null}
          </g>
        ) : null}
      </svg>
    </div>
  );
};
