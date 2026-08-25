CREATE DATABASE IF NOT EXISTS liquidmap;

CREATE TABLE IF NOT EXISTS liquidmap.storage_migrations
(
    version String,
    applied_at DateTime64(3, 'UTC') DEFAULT now64(3),
    checksum FixedString(64)
)
ENGINE = MergeTree
ORDER BY (version);

CREATE TABLE IF NOT EXISTS liquidmap.raw_trades_v1
(
    schema_version UInt16,
    exchange LowCardinality(String),
    symbol LowCardinality(String),
    capture_id String,
    capture_sequence UInt64,
    exchange_timestamp DateTime64(3, 'UTC'),
    received_timestamp DateTime64(3, 'UTC'),
    trade_id String,
    price_ticks Int64 CODEC(Delta, ZSTD(3)),
    tick_size Decimal64(12),
    quantity Decimal128(18),
    side Enum8('buy' = 1, 'sell' = 2),
    inserted_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = MergeTree
PARTITION BY (exchange, symbol, toYYYYMM(exchange_timestamp))
ORDER BY (exchange, symbol, exchange_timestamp, capture_id, capture_sequence)
TTL toDateTime(exchange_timestamp) + INTERVAL 90 DAY DELETE
SETTINGS index_granularity = 8192;

CREATE TABLE IF NOT EXISTS liquidmap.depth_snapshots_v1
(
    schema_version UInt16,
    exchange LowCardinality(String),
    symbol LowCardinality(String),
    capture_id String,
    capture_sequence UInt64,
    exchange_timestamp DateTime64(3, 'UTC'),
    received_timestamp DateTime64(3, 'UTC'),
    last_update_id UInt64 CODEC(Delta, ZSTD(3)),
    tick_size Decimal64(12),
    bids_price_ticks Array(Int64) CODEC(ZSTD(3)),
    bids_quantity Array(Decimal128(18)) CODEC(ZSTD(3)),
    asks_price_ticks Array(Int64) CODEC(ZSTD(3)),
    asks_quantity Array(Decimal128(18)) CODEC(ZSTD(3)),
    state_fingerprint FixedString(64),
    inserted_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = MergeTree
PARTITION BY (exchange, symbol, toYYYYMM(exchange_timestamp))
ORDER BY (exchange, symbol, exchange_timestamp, capture_id, capture_sequence)
TTL toDateTime(exchange_timestamp) + INTERVAL 30 DAY DELETE
SETTINGS index_granularity = 2048;

CREATE TABLE IF NOT EXISTS liquidmap.depth_deltas_v1
(
    schema_version UInt16,
    exchange LowCardinality(String),
    symbol LowCardinality(String),
    capture_id String,
    capture_sequence UInt64,
    exchange_timestamp DateTime64(3, 'UTC'),
    received_timestamp DateTime64(3, 'UTC'),
    sequence_start UInt64 CODEC(Delta, ZSTD(3)),
    sequence_end UInt64 CODEC(Delta, ZSTD(3)),
    previous_sequence Nullable(UInt64) CODEC(Delta, ZSTD(3)),
    tick_size Decimal64(12),
    bids_price_ticks Array(Int64) CODEC(ZSTD(3)),
    bids_quantity Array(Decimal128(18)) CODEC(ZSTD(3)),
    asks_price_ticks Array(Int64) CODEC(ZSTD(3)),
    asks_quantity Array(Decimal128(18)) CODEC(ZSTD(3)),
    inserted_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = MergeTree
PARTITION BY (exchange, symbol, toYYYYMM(exchange_timestamp))
ORDER BY (exchange, symbol, exchange_timestamp, capture_id, capture_sequence)
TTL toDateTime(exchange_timestamp) + INTERVAL 14 DAY DELETE
SETTINGS index_granularity = 8192;

CREATE TABLE IF NOT EXISTS liquidmap.metric_frames_v1
(
    schema_version UInt16,
    exchange LowCardinality(String),
    symbol LowCardinality(String),
    capture_id String,
    capture_sequence UInt64,
    exchange_timestamp DateTime64(3, 'UTC'),
    received_timestamp DateTime64(3, 'UTC'),
    resolution_ms UInt32,
    interval_start DateTime64(3, 'UTC'),
    interval_end DateTime64(3, 'UTC'),
    interval_buy_volume Float64,
    interval_sell_volume Float64,
    interval_trade_count UInt64,
    last_price Nullable(Float64),
    best_bid Nullable(Float64),
    best_ask Nullable(Float64),
    spread Nullable(Float64),
    delta Float64,
    cvd Float64,
    buy_volume Float64,
    sell_volume Float64,
    buy_sell_ratio Float64,
    imbalance Float64,
    trade_rate Float64,
    volume_ratio Float64,
    momentum_short Float64,
    momentum_medium Float64,
    latency_ms Nullable(Float64),
    stale Bool,
    trend_direction LowCardinality(String),
    trend_score Float64,
    trend_confidence Float64,
    trend_active Bool,
    trend_strength LowCardinality(String),
    trend_since Nullable(DateTime64(3, 'UTC')),
    trend_reasons Array(String),
    book_fingerprint Nullable(FixedString(64)),
    analytics_fingerprint Nullable(FixedString(64)),
    inserted_at DateTime64(3, 'UTC') DEFAULT now64(3),
    CONSTRAINT valid_resolution CHECK resolution_ms IN (1000, 5000, 60000)
)
ENGINE = MergeTree
PARTITION BY (exchange, symbol, resolution_ms, toYYYYMM(exchange_timestamp))
ORDER BY (exchange, symbol, resolution_ms, exchange_timestamp, capture_id, capture_sequence)
TTL if(
    resolution_ms = 60000,
    toDateTime(exchange_timestamp) + INTERVAL 1095 DAY,
    toDateTime(exchange_timestamp) + INTERVAL 365 DAY
) DELETE
SETTINGS index_granularity = 8192;
