export interface TapeTrade {
  id: string;
  time: string;
  price: string;
  size: string;
  side: 'buy' | 'sell';
}

interface RecentTradesProps {
  trades: TapeTrade[];
}

export function RecentTrades({ trades }: RecentTradesProps) {
  return (
    <section className="panel trades-panel" aria-label="Transaksi terbaru">
      <div className="panel-title-row compact">
        <div>
          <span className="eyebrow">TIME &amp; SALES</span>
          <h2>Transaksi terbaru</h2>
        </div>
        <span className="trade-count">{trades.length}</span>
      </div>
      <div className="trades-head" aria-hidden="true">
        <span>Waktu</span><span>Harga</span><span>Jumlah</span>
      </div>
      <div className="trades-list">
        {trades.slice(0, 7).map((trade) => (
          <div className={`trade-row ${trade.side}`} key={trade.id}>
            <span>{trade.time}</span>
            <strong>{trade.price}</strong>
            <span>{trade.size}</span>
          </div>
        ))}
        {trades.length === 0 && <div className="empty-trades">Menunggu transaksi…</div>}
      </div>
    </section>
  );
}
