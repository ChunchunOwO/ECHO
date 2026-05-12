import type { EqBand } from '../../../shared/types/eq';

type EqCurveViewProps = {
  bands: EqBand[];
  preampDb: number;
  enabled: boolean;
};

const width = 720;
const height = 210;
const paddingX = 34;
const centerY = height / 2;
const gainScale = 7;

const formatPoint = (band: EqBand, index: number, bands: EqBand[], preampDb: number): string => {
  const x = paddingX + (index / Math.max(1, bands.length - 1)) * (width - paddingX * 2);
  const y = centerY - (band.gainDb + preampDb * 0.35) * gainScale;
  return `${x.toFixed(1)},${Math.max(20, Math.min(height - 20, y)).toFixed(1)}`;
};

export const EqCurveView = ({ bands, preampDb, enabled }: EqCurveViewProps): JSX.Element => {
  const points = bands.map((band, index) => formatPoint(band, index, bands, preampDb)).join(' ');
  const areaPoints = `${paddingX},${centerY} ${points} ${width - paddingX},${centerY}`;

  return (
    <div className="eq-curve-shell" data-enabled={enabled}>
      <svg className="eq-curve-view" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="EQ curve display">
        <defs>
          <linearGradient id="eqCurveStroke" x1="0%" x2="100%" y1="0%" y2="0%">
            <stop offset="0%" stopColor="#78a9d8" />
            <stop offset="48%" stopColor="#d4b16a" />
            <stop offset="100%" stopColor="#e0a777" />
          </linearGradient>
          <linearGradient id="eqCurveFill" x1="0%" x2="0%" y1="0%" y2="100%">
            <stop offset="0%" stopColor="rgba(224, 167, 119, 0.24)" />
            <stop offset="100%" stopColor="rgba(120, 169, 216, 0.06)" />
          </linearGradient>
        </defs>
        {[36, 72, 108, 144, 180].map((lineY) => (
          <line className="eq-grid-line" x1="22" x2={width - 22} y1={lineY} y2={lineY} key={lineY} />
        ))}
        {bands.map((band, index) => {
          const x = paddingX + (index / Math.max(1, bands.length - 1)) * (width - paddingX * 2);
          return <line className="eq-grid-line eq-grid-line--vertical" x1={x} x2={x} y1="20" y2={height - 20} key={band.frequencyHz} />;
        })}
        <line className="eq-zero-line" x1="22" x2={width - 22} y1={centerY} y2={centerY} />
        <polygon className="eq-curve-fill" points={areaPoints} />
        <polyline className="eq-curve-stroke" points={points} />
        {bands.map((band, index) => {
          const [x, y] = formatPoint(band, index, bands, preampDb).split(',').map(Number);
          return <circle className="eq-curve-node" cx={x} cy={y} r="4.2" key={band.frequencyHz} />;
        })}
      </svg>
      <div className="eq-spectrum-placeholder">
        <span />
        <span />
        <span />
        <span />
        <span />
        <span />
        <span />
        <span />
      </div>
    </div>
  );
};
