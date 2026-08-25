import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';

/** Phase 4 instrument metadata mirrored from the gateway registry. */
export interface InstrumentMeta {
  symbol: string;
  short: string;
  quote: string;
  mark: string;
  accent: string;
  tickSize: number;
}

export const INSTRUMENT_META: Record<string, InstrumentMeta> = {
  BTCUSDT: { symbol: 'BTCUSDT', short: 'BTC', quote: 'USDT', mark: '₿', accent: '#f59d21', tickSize: 0.1 },
  ETHUSDT: { symbol: 'ETHUSDT', short: 'ETH', quote: 'USDT', mark: 'Ξ', accent: '#627eea', tickSize: 0.01 },
  SOLUSDT: { symbol: 'SOLUSDT', short: 'SOL', quote: 'USDT', mark: '◎', accent: '#14f195', tickSize: 0.01 },
};

export function metaForSymbol(symbol: string): InstrumentMeta {
  return (
    INSTRUMENT_META[symbol] ?? {
      symbol,
      short: symbol.replace(/USDT$/, ''),
      quote: symbol.endsWith('USDT') ? 'USDT' : '',
      mark: symbol.slice(0, 1),
      accent: '#50c8ff',
      tickSize: 0.01,
    }
  );
}

export function decimalsForTickSize(tickSize: number): number {
  if (tickSize >= 1) return 0;
  if (tickSize >= 0.1) return 1;
  if (tickSize >= 0.01) return 2;
  return 3;
}

interface SymbolPickerProps {
  current: string;
  watchlist: readonly string[];
  onSelect: (symbol: string) => void;
  onToggleWatch: (symbol: string) => void;
}

/**
 * Phase 4 market switcher: searchable instrument list plus a persistent
 * watchlist. Selecting a symbol swaps the live subscription without any page
 * reload.
 */
export function SymbolPicker({ current, watchlist, onSelect, onToggleWatch }: SymbolPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (open) searchRef.current?.focus();
    else setQuery('');
  }, [open]);

  const normalizedQuery = query.trim().toUpperCase();
  const instruments = useMemo(() => Object.values(INSTRUMENT_META), []);
  const matches = useMemo(() => {
    if (!normalizedQuery) return instruments;
    return instruments.filter((instrument) =>
      `${instrument.symbol} ${instrument.short}/${instrument.quote}`.includes(normalizedQuery));
  }, [instruments, normalizedQuery]);
  const watchedMatches = matches.filter((instrument) => watchlist.includes(instrument.symbol));
  const restMatches = matches.filter((instrument) => !watchlist.includes(instrument.symbol));
  const activeInstrument = metaForSymbol(current);

  const select = (symbol: string) => {
    onSelect(symbol);
    setOpen(false);
  };

  const renderRow = (instrument: InstrumentMeta, watched: boolean) => (
    <div
      className={`picker-row ${instrument.symbol === current ? 'active' : ''}`}
      key={instrument.symbol}
      onClick={() => select(instrument.symbol)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          select(instrument.symbol);
        }
      }}
      role="button"
      tabIndex={0}
    >
      <span className="asset-logo" style={{ background: instrument.accent }}>{instrument.mark}</span>
      <span className="picker-copy">
        <strong>{instrument.short} / {instrument.quote}</strong>
        <small>Binance · Perpetual · tick {instrument.tickSize}</small>
      </span>
      <button
        aria-label={watched ? `Hapus ${instrument.symbol} dari watchlist` : `Tambah ${instrument.symbol} ke watchlist`}
        className={`picker-star ${watched ? 'on' : ''}`}
        onClick={(event) => {
          event.stopPropagation();
          onToggleWatch(instrument.symbol);
        }}
        title={watched ? 'Hapus dari watchlist' : 'Tambah ke watchlist'}
        type="button"
      >
        <Icon name="star" size={13} />
      </button>
    </div>
  );

  return (
    <div className="symbol-picker" ref={containerRef}>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        className="market-selector"
        onClick={() => setOpen((value) => !value)}
        title="Pilih market"
        type="button"
      >
        <span className="asset-logo" style={{ background: activeInstrument.accent }}>{activeInstrument.mark}</span>
        <span className="market-copy">
          <strong>{activeInstrument.short} / {activeInstrument.quote}</strong>
          <span>Binance · Perpetual</span>
        </span>
        <Icon name="chevron" size={13} />
      </button>

      {open && (
        <div aria-label="Pilih simbol" className="picker-panel" role="dialog">
          <div className="picker-search">
            <Icon name="search" size={12} />
            <input
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Cari simbol…"
              ref={searchRef}
              type="text"
              value={query}
            />
          </div>

          {matches.length === 0 && (
            <p className="picker-empty">Tidak ada simbol yang cocok “{query}”.</p>
          )}

          {watchedMatches.length > 0 && (
            <>
              <p className="picker-section-label">Watchlist</p>
              {watchedMatches.map((instrument) => renderRow(instrument, true))}
            </>
          )}

          {restMatches.length > 0 && (
            <>
              <p className="picker-section-label">Semua simbol</p>
              {restMatches.map((instrument) => renderRow(instrument, false))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
