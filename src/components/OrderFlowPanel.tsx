interface FlowMetric {
  label: string;
  value: string;
  detail: string;
  tone: 'positive' | 'negative' | 'neutral';
  ratio?: number;
}

export interface OrderFlowPanelProps {
  metrics: FlowMetric[];
  buyRatio: number;
}

export function OrderFlowPanel({ metrics, buyRatio }: OrderFlowPanelProps) {
  const safeBuyRatio = Math.max(0, Math.min(100, buyRatio));

  return (
    <section className="panel flow-panel" aria-label="Metrik order flow">
      <div className="panel-title-row compact">
        <div>
          <span className="eyebrow">ORDER FLOW</span>
          <h2>Tekanan pasar</h2>
        </div>
        <span className="live-mini"><i /> LIVE</span>
      </div>

      <div className="buy-sell-header">
        <span><i className="buy-dot" /> BUY {safeBuyRatio.toFixed(0)}%</span>
        <span>SELL {(100 - safeBuyRatio).toFixed(0)}% <i className="sell-dot" /></span>
      </div>
      <div className="buy-sell-bar" aria-label={`Buy ${safeBuyRatio.toFixed(0)} persen`}>
        <i className="buy-fill" style={{ width: `${safeBuyRatio}%` }} />
        <i className="sell-fill" style={{ width: `${100 - safeBuyRatio}%` }} />
      </div>

      <div className="metric-stack">
        {metrics.map((metric) => (
          <div className="flow-metric" key={metric.label}>
            <div>
              <span>{metric.label}</span>
              <small>{metric.detail}</small>
            </div>
            <strong className={metric.tone}>{metric.value}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}
