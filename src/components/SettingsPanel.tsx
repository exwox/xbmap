import { useEffect, useRef } from 'react';
import { Icon } from './Icon';

export interface VisualSettings {
  heatmapThreshold: number;
  bubbleScale: number;
  depth: number;
  timeWindowMs: number;
}

interface SettingsPanelProps {
  open: boolean;
  settings: VisualSettings;
  onChange: (settings: VisualSettings) => void;
  onClose: () => void;
  onSnapshot: () => void;
}

const windows = [
  { label: '30 detik', value: 30_000 },
  { label: '1 menit', value: 60_000 },
  { label: '3 menit', value: 180_000 },
  { label: '5 menit', value: 300_000 },
];

export function SettingsPanel({
  open,
  settings,
  onChange,
  onClose,
  onSnapshot,
}: SettingsPanelProps) {
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeButton.current?.focus();
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [onClose, open]);

  if (!open) return null;

  const update = <K extends keyof VisualSettings>(key: K, value: VisualSettings[K]) => {
    onChange({ ...settings, [key]: value });
  };

  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={onClose}>
      <aside
        aria-label="Pengaturan visualisasi"
        aria-modal="true"
        className="settings-sheet"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="settings-header">
          <div>
            <span className="eyebrow">WORKSPACE</span>
            <h2>Pengaturan visual</h2>
          </div>
          <button className="icon-button" ref={closeButton} type="button" onClick={onClose} aria-label="Tutup pengaturan">
            <span aria-hidden="true" className="close-symbol">×</span>
          </button>
        </div>

        <div className="settings-body">
          <label className="setting-control">
            <span>
              <strong>Filter likuiditas</strong>
              <small>Kurangi noise pada heatmap</small>
            </span>
            <output>{Math.round(settings.heatmapThreshold * 100)}%</output>
            <input
              min="0"
              max="0.9"
              step="0.05"
              type="range"
              value={settings.heatmapThreshold}
              onChange={(event) => update('heatmapThreshold', Number(event.target.value))}
            />
          </label>

          <label className="setting-control">
            <span>
              <strong>Skala bubble</strong>
              <small>Ukuran transaksi agresif</small>
            </span>
            <output>{settings.bubbleScale.toFixed(1)}×</output>
            <input
              min="0.5"
              max="2.5"
              step="0.1"
              type="range"
              value={settings.bubbleScale}
              onChange={(event) => update('bubbleScale', Number(event.target.value))}
            />
          </label>

          <label className="setting-control">
            <span>
              <strong>Kedalaman order book</strong>
              <small>Jumlah level per sisi</small>
            </span>
            <select value={settings.depth} onChange={(event) => update('depth', Number(event.target.value))}>
              {[25, 50, 80, 100, 150, 200].map((depth) => (
                <option key={depth} value={depth}>{depth} level</option>
              ))}
            </select>
          </label>

          <fieldset className="setting-window">
            <legend>Rentang waktu default</legend>
            <div>
              {windows.map((windowOption) => (
                <button
                  className={settings.timeWindowMs === windowOption.value ? 'active' : ''}
                  key={windowOption.value}
                  onClick={() => update('timeWindowMs', windowOption.value)}
                  type="button"
                >
                  {windowOption.label}
                </button>
              ))}
            </div>
          </fieldset>

          <div className="settings-callout">
            <Icon name="layers" size={17} />
            <div>
              <strong>Order book tidak sinkron?</strong>
              <span>Minta snapshot baru tanpa memuat ulang halaman.</span>
            </div>
            <button type="button" onClick={onSnapshot}>Sinkronkan</button>
          </div>
        </div>

        <div className="settings-footer">
          <span>Perubahan diterapkan langsung</span>
          <button type="button" onClick={onClose}>Selesai</button>
        </div>
      </aside>
    </div>
  );
}
