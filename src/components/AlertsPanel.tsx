import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import type { AlertNotification, InsightFrame } from '../types/market';
import {
  createAlertRule,
  deleteAlertRule,
  fetchAlertRules,
  updateAlertRule,
  type AlertKind,
  type AlertRulesResponse,
  type AlertRule,
} from '../lib/alertsApi';

const KIND_LABELS: Record<AlertKind, string> = {
  trend_score: 'Trend score',
  liquidity_wall: 'Liquidity wall',
  volume_delta: 'Volume delta',
  trade_velocity: 'Trade velocity',
};

const COOLDOWN_OPTIONS = [
  { label: '30 detik', value: 30_000 },
  { label: '1 menit', value: 60_000 },
  { label: '5 menit', value: 300_000 },
];

function playBeep(): void {
  try {
    const Ctor = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const context = new Ctor();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 880;
    gain.gain.value = 0.05;
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    window.setTimeout(() => {
      oscillator.stop();
      void context.close();
    }, 180);
  } catch {
    // Audio unavailable (autoplay policy / no device): silent fallback.
  }
}

interface FormState {
  kind: AlertKind;
  scope: 'current' | '*';
  thresholdMode: 'baseline' | 'absolute';
  multiplier: number;
  absoluteValue: number;
  op: 'above' | 'below';
  wallState: 'appeared' | 'disappeared';
  cooldownMs: number;
  sound: boolean;
}

function defaultForm(currentSymbol: string): FormState {
  return {
    kind: 'trend_score',
    scope: 'current',
    thresholdMode: 'absolute',
    multiplier: 3,
    absoluteValue: 70,
    op: 'above',
    wallState: 'appeared',
    cooldownMs: 60_000,
    sound: true,
  };
}

interface AlertsPanelProps {
  open: boolean;
  currentSymbol: string;
  insight: InsightFrame | null;
  alertsFeed: readonly AlertNotification[];
  onClose: () => void;
}

/**
 * Phase 5 alerts drawer: user-configurable rules over the advanced analytics
 * stream, plus the triggered-alert feed with browser notification and sound.
 */
export function AlertsPanel({ open, currentSymbol, insight, alertsFeed, onClose }: AlertsPanelProps) {
  const [rulesData, setRulesData] = useState<AlertRulesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(() => defaultForm(currentSymbol));
  const [soundEnabled, setSoundEnabled] = useState(
    () => localStorage.getItem('liquidmap.alert-sound') !== '0',
  );
  const lastAlertIdRef = useRef<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRulesData(await fetchAlertRules());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void reload();
  }, [open, reload]);

  useEffect(() => {
    const latest = alertsFeed[0];
    if (!latest || latest.alertId === lastAlertIdRef.current) return;
    lastAlertIdRef.current = latest.alertId;
    if (!open) return;
    if (soundEnabled && latest.sound) playBeep();
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        new Notification(`LiquidMap · ${KIND_LABELS[latest.kind]}`, {
          body: `${latest.symbol}: ${latest.reason}`,
        });
      } catch {
        // Notification construction can reject without a service worker.
      }
    }
  }, [alertsFeed, open, soundEnabled]);

  const toggleSound = useCallback(() => {
    setSoundEnabled((value) => {
      const next = !value;
      try {
        localStorage.setItem('liquidmap.alert-sound', next ? '1' : '0');
      } catch {
        // Ignore storage failures; session-only behavior remains.
      }
      return next;
    });
  }, []);

  const requestNotificationPermission = useCallback(async () => {
    if (typeof Notification === 'undefined' || Notification.permission !== 'default') return;
    await Notification.requestPermission();
  }, []);

  const submitForm = useCallback(async () => {
    setError(null);
    try {
      await createAlertRule({
        kind: form.kind,
        symbol: form.scope === 'current' ? currentSymbol : '*',
        thresholdMode: form.thresholdMode,
        ...(form.thresholdMode === 'baseline'
          ? { multiplier: form.multiplier }
          : { absoluteValue: form.absoluteValue }),
        ...(form.kind === 'liquidity_wall' ? { wallState: form.wallState } : { op: form.op }),
        cooldownMs: form.cooldownMs,
        sound: form.sound,
        enabled: true,
      });
      setShowForm(false);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [currentSymbol, form, reload]);

  const toggleRule = useCallback(async (rule: AlertRule) => {
    try {
      await updateAlertRule(rule.id, { enabled: !rule.enabled });
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [reload]);

  const removeRule = useCallback(async (rule: AlertRule) => {
    try {
      await deleteAlertRule(rule.id);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [reload]);

  // JSX_MARKER

  if (!open) return null;
  const fundingPct = insight?.derivatives.fundingRate != null
    ? (insight.derivatives.fundingRate * 100).toFixed(4)
    : '—';
  const vwapValue = insight?.rollingVwap.value ?? null;
  const vwapLabel = vwapValue === null ? '—' : vwapValue.toFixed(vwapValue >= 100 ? 1 : 2);
  const topWall = insight?.walls[0];

  return (
    <div className="alerts-drawer" aria-label="Panel alert" role="dialog">
      <div className="drawer-head">
        <div>
          <span className="eyebrow">ALERTS</span>
          <h2>Aturan & sinyal</h2>
          {rulesData?.shadowMode && <span className="badge badge-shadow">SHADOW MODE</span>}
        </div>
        <div className="drawer-actions">
          <button
            className={`tool-button ${soundEnabled ? 'active' : ''}`}
            onClick={toggleSound}
            title="Suara saat alert"
            type="button"
          >
            {soundEnabled ? 'Suara ON' : 'Suara OFF'}
          </button>
          <button className="icon-button" onClick={onClose} aria-label="Tutup panel alert" type="button">
            <Icon name="close" size={14} />
          </button>
        </div>
      </div>

      {error && <p className="drawer-error">{error}</p>}

      <section className="insight-card" aria-label="Insight pasar">
        <p className="picker-section-label">MARKET INSIGHTS · {insight?.symbol ?? currentSymbol}</p>
        <div className="insight-grid">
          <div><small>Rolling VWAP</small><strong>{vwapLabel}</strong></div>
          <div><small>Funding</small><strong>{fundingPct}%</strong></div>
          <div><small>Open interest</small><strong>{insight?.derivatives.openInterest != null ? insight.derivatives.openInterest.toLocaleString() : '—'}</strong></div>
          <div><small>POC profil</small><strong>{insight?.volumeProfile.pocPrice ?? '—'}</strong></div>
          <div><small>Dinding terbesar</small><strong>{topWall ? `${topWall.side.toUpperCase()} ${topWall.price}` : '—'}</strong></div>
          <div><small>Likuidasi 60s</small><strong>{insight ? insight.liquidations.longLiquidations + insight.liquidations.shortLiquidations : '—'}</strong></div>
        </div>
        {insight?.absorption && (
          <p className={`chip chip-${insight.absorption.direction}`}>
            ABSORPSI {insight.absorption.direction.toUpperCase()} · {insight.absorption.reason}
          </p>
        )}
        {insight?.exhaustion.direction && (
          <p className="chip chip-warning">{insight.exhaustion.reason}</p>
        )}
      </section>

      <section className="drawer-section" aria-label="Aturan alert">
        <div className="section-head">
          <p className="picker-section-label">ATURAN ({rulesData?.rules.length ?? 0})</p>
          <button className="tool-button" onClick={() => setShowForm((value) => !value)} type="button">
            <Icon name="plus" size={11} /> Aturan
          </button>
        </div>

        {loading && <p className="picker-empty">Memuat…</p>}
        {!loading && (rulesData?.rules.length ?? 0) === 0 && (
          <p className="picker-empty">Belum ada aturan. Tambahkan aturan pertama Anda.</p>
        )}

        {(rulesData?.rules ?? []).map((rule) => (
          <div className="alert-rule-row" key={rule.id}>
            <label className="rule-toggle">
              <input checked={rule.enabled} onChange={() => void toggleRule(rule)} type="checkbox" />
              <span>
                <strong>{KIND_LABELS[rule.kind]}</strong>
                <small>
                  {rule.symbol} ·{' '}
                  {rule.kind === 'liquidity_wall'
                    ? `dinding ${rule.wallState}`
                    : rule.thresholdMode === 'baseline'
                      ? `baseline ×${rule.multiplier}`
                      : `${rule.op} ${rule.absoluteValue}`}
                  {' '}· cd {Math.round(rule.cooldownMs / 1_000)}s
                </small>
              </span>
            </label>
            <button
              aria-label={`Hapus aturan ${KIND_LABELS[rule.kind]}`}
              className="icon-button danger"
              onClick={() => void removeRule(rule)}
              type="button"
            >
              <Icon name="trash" size={13} />
            </button>
          </div>
        ))}

        {showForm && (
          <form
            className="alert-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submitForm();
            }}
          >
            <select
              onChange={(event) => setForm((state) => ({ ...state, kind: event.target.value as AlertKind }))}
              value={form.kind}
            >
              {(Object.keys(KIND_LABELS) as AlertKind[]).map((kind) => (
                <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>
              ))}
            </select>

            <select
              onChange={(event) => setForm((state) => ({
                ...state,
                scope: event.target.value as 'current' | '*',
              }))}
              value={form.scope}
            >
              <option value="current">{currentSymbol}</option>
              <option value="*">Semua simbol</option>
            </select>

            {form.kind === 'liquidity_wall' ? (
              <select
                onChange={(event) => setForm((state) => ({
                  ...state,
                  wallState: event.target.value as 'appeared' | 'disappeared',
                }))}
                value={form.wallState}
              >
                <option value="appeared">Dinding muncul</option>
                <option value="disappeared">Dinding hilang</option>
              </select>
            ) : (
              <>
                <select
                  onChange={(event) => setForm((state) => ({
                    ...state,
                    op: event.target.value as 'above' | 'below',
                  }))}
                  value={form.op}
                >
                  <option value="above">Di atas</option>
                  <option value="below">Di bawah</option>
                </select>
                <select
                  disabled={form.kind === 'trend_score'}
                  onChange={(event) => setForm((state) => ({
                    ...state,
                    thresholdMode: event.target.value as 'baseline' | 'absolute',
                  }))}
                  value={form.thresholdMode}
                >
                  <option disabled={form.kind === 'trend_score'} value="baseline">Baseline simbol</option>
                  <option value="absolute">Nilai mutlak</option>
                </select>
                {form.thresholdMode === 'baseline' ? (
                  <input
                    min={1}
                    onChange={(event) => setForm((state) => ({ ...state, multiplier: Number(event.target.value) }))}
                    step={0.5}
                    type="number"
                    value={form.multiplier}
                  />
                ) : (
                  <input
                    onChange={(event) => setForm((state) => ({ ...state, absoluteValue: Number(event.target.value) }))}
                    step={1}
                    type="number"
                    value={form.absoluteValue}
                  />
                )}
              </>
            )}

            <select
              onChange={(event) => setForm((state) => ({ ...state, cooldownMs: Number(event.target.value) }))}
              value={form.cooldownMs}
            >
              {COOLDOWN_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>Cooldown {option.label}</option>
              ))}
            </select>

            <label className="rule-toggle sound-option">
              <input
                checked={form.sound}
                onChange={(event) => setForm((state) => ({ ...state, sound: event.target.checked }))}
                type="checkbox"
              />
              <span>Bunyikan suara</span>
            </label>

            <button className="submit-button" type="submit">Buat alert</button>
          </form>
        )}
      </section>
      <section className="drawer-section" aria-label="Alert terpicu">
        <p className="picker-section-label">TERPICU TERBARU</p>
        {typeof Notification !== 'undefined' && Notification.permission === 'default' && (
          <button
            className="tool-button"
            onClick={() => void requestNotificationPermission()}
            type="button"
          >
            Izinkan notifikasi browser
          </button>
        )}
        {alertsFeed.length === 0 && <p className="picker-empty">Belum ada alert yang terpicu.</p>}
        {alertsFeed.map((notification) => (
          <div className="alert-event-row" key={notification.alertId}>
            <span className={`badge badge-${notification.direction ?? 'neutral'}`}>
              {notification.direction ?? '•'}
            </span>
            <span className="alert-event-copy">
              <strong>{KIND_LABELS[notification.kind]} · {notification.symbol}</strong>
              <small>{notification.reason}</small>
            </span>
          </div>
        ))}
      </section>
    </div>
  );
}
