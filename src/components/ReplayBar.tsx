import { Icon } from './Icon';

interface ReplayBarProps {
  playing: boolean;
  progress: number;
  speed: number;
  label: string;
  onToggle: () => void;
  onProgress: (progress: number) => void;
  onSpeed: () => void;
  onReset: () => void;
}

export function ReplayBar({
  playing,
  progress,
  speed,
  label,
  onToggle,
  onProgress,
  onSpeed,
  onReset,
}: ReplayBarProps) {
  return (
    <div className="replay-bar" aria-label="Kontrol replay">
      <button className="icon-button replay-play" type="button" onClick={onToggle} aria-label={playing ? 'Jeda replay' : 'Putar replay'}>
        <Icon name={playing ? 'pause' : 'play'} size={16} />
      </button>
      <button className="speed-button" type="button" onClick={onSpeed}>{speed}×</button>
      <span className="replay-time">{label}</span>
      <input
        aria-label="Posisi replay"
        className="replay-range"
        max="100"
        min="0"
        onChange={(event) => onProgress(Number(event.target.value))}
        style={{ '--range-progress': `${progress}%` } as React.CSSProperties}
        type="range"
        value={progress}
      />
      <span className="replay-mode-label">REPLAY</span>
      <button className="icon-button" type="button" onClick={onReset} aria-label="Ulangi replay">
        <Icon name="reset" size={15} />
      </button>
    </div>
  );
}
