import { Icon } from './Icon';

export interface TrendPanelProps {
  score: number;
  direction: 'up' | 'down' | 'neutral';
  confidence: number;
  reasons: readonly string[];
  regime?: string;
  paused?: boolean;
  pausedReason?: string;
}

const directionCopy = {
  up: { label: 'BULLISH KUAT', caption: 'Tekanan beli dominan' },
  down: { label: 'BEARISH KUAT', caption: 'Tekanan jual dominan' },
  neutral: { label: 'PASAR NETRAL', caption: 'Menunggu konfirmasi' },
};

export function TrendPanel({
  score,
  direction,
  confidence,
  reasons,
  regime = 'Momentum',
  paused = false,
  pausedReason = 'Order book belum tervalidasi',
}: TrendPanelProps) {
  const safeScore = paused ? 0 : Math.max(0, Math.min(100, score));
  const effectiveDirection = paused ? 'neutral' : direction;
  const copy = paused
    ? { label: 'SIGNAL DITAHAN', caption: 'Book belum valid' }
    : directionCopy[direction];
  const visibleReasons = paused ? [pausedReason] : reasons;

  return (
    <section
      className={`panel trend-panel trend-${effectiveDirection} ${paused ? 'trend-paused' : ''}`}
      aria-label={paused ? 'Analisis tren — sinyal ditahan' : 'Analisis tren'}
    >
      <div className="panel-title-row">
        <div>
          <span className="eyebrow">TREND ENGINE</span>
          <h2>Kekuatan tren</h2>
        </div>
        <span className="panel-chip">
          <Icon name="zap" size={13} /> {paused ? 'DATA PAUSED' : regime}
        </span>
      </div>

      <div className="trend-score-wrap">
        <div
          className="trend-gauge"
          style={{ '--trend-score': `${safeScore * 3.6}deg` } as React.CSSProperties}
          aria-label={`Skor tren ${Math.round(safeScore)} dari 100`}
        >
          <div className="trend-gauge-inner">
            <strong>{Math.round(safeScore)}</strong>
            <span>/ 100</span>
          </div>
        </div>
        <div className="trend-verdict">
          <span className="trend-direction">
            <i aria-hidden="true" /> {copy.label}
          </span>
          <strong>{copy.caption}</strong>
          <span>Confidence {paused ? 0 : Math.round(confidence)}%</span>
        </div>
      </div>

      <div className="confidence-track" aria-hidden="true">
        <i style={{ width: `${paused ? 0 : Math.max(0, Math.min(100, confidence))}%` }} />
      </div>

      <div className="reason-list">
        {visibleReasons.slice(0, 3).map((reason) => (
          <span key={reason}>
            <i aria-hidden="true">{paused ? '!' : '✓'}</i> {reason}
          </span>
        ))}
        {visibleReasons.length === 0 && <span className="muted-copy">Belum ada konfirmasi yang cukup</span>}
      </div>
    </section>
  );
}
