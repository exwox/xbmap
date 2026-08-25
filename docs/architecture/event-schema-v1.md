# LiquidMap Event Schema v1

Status: implementation inventory as of 2026-08-24.

Dokumen ini menjelaskan kontrak yang benar-benar dibaca dan ditulis oleh kode
saat ini. Ia tidak menganggap interface TypeScript sebagai runtime validation.
Keputusan target dan aturan evolusi ada di
[ADR 0002](../adr/0002-canonical-event-schema-versioning.md); gap terhadap
keputusan tersebut dikumpulkan di bagian terakhir.

## 1. Scope and notation

- Transport server adalah JSON melalui REST `/api/v1/*` dan WebSocket `/ws`.
- `number` berarti JSON number yang finite pada producer normal.
- Seluruh timestamp producer adalah UTC Unix epoch milliseconds.
- Price level wire server-to-client adalah tuple `[price, quantity]`, keduanya
  number. Adapter Binance menerima string atau number sebelum normalisasi.
- `exchange` selalu `"binance"` pada gateway saat ini, termasuk ketika
  `data.source` adalah `"demo"`.
- `symbol` adalah uppercase dan default `"BTCUSDT"`.
- Tidak ada authentication atau user/workspace scope pada kontrak v1.

## 2. Canonical process-local input

Tiga bentuk berikut diproduksi adapter dan dikonsumsi `MarketGateway`. Bentuk ini
tidak dikirim langsung ke browser dan belum membawa `schemaVersion`.

### 2.1 `DepthSnapshot`

```ts
interface DepthSnapshot {
  lastUpdateId: number;
  exchangeTimestamp?: number;
  bids: Array<[string | number, string | number]>;
  asks: Array<[string | number, string | number]>;
}
```

Runtime invariant yang ditegakkan `OrderBook.loadSnapshot`:

- `lastUpdateId` safe integer dan >= 0;
- price dan quantity dapat dikonversi menjadi finite number;
- price > 0 dan quantity > 0;
- price dapat direpresentasikan sebagai safe integer tick setelah
  `Math.round(price / tickSize)`;
- book akhir tidak crossed (`bestBid < bestAsk`).

Catatan: Binance REST depth response tidak menyediakan timestamp yang dipakai
oleh adapter ini. Adapter mengisi `exchangeTimestamp` dengan `Date.now()` setelah
response diterima; nama field tersebut karena itu bukan bukti waktu exchange
untuk snapshot.

### 2.2 `DepthUpdate`

```ts
interface DepthUpdate {
  exchangeTimestamp: number;
  receivedTimestamp: number;
  sequenceStart: number;
  sequenceEnd: number;
  previousSequence?: number;
  bids: Array<[string | number, string | number]>;
  asks: Array<[string | number, string | number]>;
}
```

Mapping Binance adalah `T ?? E -> exchangeTimestamp`, local `Date.now() ->
receivedTimestamp`, `U -> sequenceStart`, `u -> sequenceEnd`, `pu ->
previousSequence`, `b -> bids`, dan `a -> asks`.

Invariants:

- sequence start/end safe integer, >= 0, dan end >= start;
- delta quantity >= 0; `0` menghapus level;
- duplicate/pre-snapshot update dengan `sequenceEnd <= current lastUpdateId`
  diabaikan;
- first update harus melintasi `lastUpdateId + 1`;
- setelah bridge, `previousSequence`, bila ada, harus sama dengan current
  `lastUpdateId`; tanpa field itu, `sequenceStart <= lastUpdateId + 1`;
- update yang membuat book crossed ditolak dan di-rollback.

### 2.3 `NormalizedTrade`

```ts
interface NormalizedTrade {
  id: string;
  exchangeTimestamp: number;
  receivedTimestamp: number;
  price: number;
  quantity: number;
  side: "buy" | "sell";
}
```

Price dan quantity harus finite dan > 0. Untuk Binance aggregate trade, `a`
menjadi string `id`, `T` adalah exchange timestamp, dan `m=true` dipetakan ke
`side="sell"` karena buyer adalah resting maker; `m=false` menjadi aggressor
`buy`.

## 3. Server envelope

Semua event WebSocket dan response REST snapshot memakai bentuk berikut:

```ts
interface ServerEnvelope<T> {
  type: ServerEventType;
  schemaVersion: 1;
  exchange: "binance";
  symbol: string;
  serverTimestamp: number;
  exchangeTimestamp?: number;
  sequence: number;
  streamId?: string;
  deliverySequence?: number;
  data: T;
}
```

Contoh aktual yang dipadatkan dari generator demo (level lain dihapus hanya dari
contoh dokumentasi):

```json
{
  "type": "depth_frame",
  "schemaVersion": 1,
  "exchange": "binance",
  "symbol": "BTCUSDT",
  "serverTimestamp": 1787580672823,
  "exchangeTimestamp": 1787580672724,
  "sequence": 4,
  "data": {
    "lastUpdateId": 1,
    "bids": [[63999.9, 0.956], [63999.8, 1.845]],
    "asks": [[64000.1, 0.923], [64000.2, 1.781]],
    "bestBid": 63999.9,
    "bestAsk": 64000.1,
    "midPrice": 64000,
    "spread": 0.19999999999708962,
    "stale": false,
    "source": "demo"
  }
}
```

Level arrays pada event sebenarnya berisi sampai depth subscription, bukan hanya
dua level seperti cuplikan di atas.

### 3.1 Envelope `sequence`

`sequence` dimulai dari 1 setelah process/gateway dibuat ulang dan bertambah
setiap `MarketGateway.makeEnvelope` dipanggil. Counter ini global untuk seluruh
gateway, bukan per client, per subscription, atau per event type. Counter juga
dikonsumsi oleh:

- event gateway yang dibroadcast;
- status awal koneksi;
- `subscribed`, `unsubscribed`, `heartbeat`, dan `error` khusus satu client;
- on-demand/subscribe snapshot;
- `GET /api/v1/snapshot`.

Karena tidak semua envelope dikirim ke semua client, sequence yang diterima satu
client **tidak dijamin kontinu**. REST traffic dan control traffic client lain
dapat membuat lompatan. Counter ini juga berbeda dari `lastUpdateId` book.

Khusus WebSocket, server menambahkan `streamId` unik per koneksi dan
`deliverySequence` 1-based tepat sebelum `socket.send`. Counter delivery kontinu
untuk envelope yang benar-benar dikirim pada koneksi tersebut. Kedua field tidak
ditambahkan ke response REST maupun source envelope gateway.

## 4. WebSocket protocol

### 4.1 Transport lifecycle

- Upgrade hanya diterima pada path `/ws`; path lain mendapat HTTP 404 lalu
  socket ditutup.
- Jika `CORS_ORIGIN` dikonfigurasi, header Origin yang ada harus masuk allowlist.
- `perMessageDeflate` nonaktif dan inbound `maxPayload` adalah 64 KiB.
- Server langsung mengirim satu envelope `status` ketika connection dibuka,
  sebelum client subscribe.
- Server mengirim WebSocket control ping setiap 15 detik. Client yang tidak
  membalas pong sebelum siklus berikutnya di-terminate.
- Client resmi juga mengirim application message `ping` default setiap 10 detik.

### 4.2 Client messages

Server melakukan `JSON.parse`, memastikan value adalah object dan `type` adalah
string, lalu melakukan branch berdasarkan `type`. Ia belum memvalidasi seluruh
field atau `schemaVersion`.

#### Subscribe

```json
{
  "type": "subscribe",
  "schemaVersion": 1,
  "exchange": "binance",
  "symbol": "BTCUSDT",
  "market": "perpetual",
  "depth": 80
}
```

Perilaku runtime:

- `exchange`, `symbol`, dan `depth` optional bagi server;
- default exchange `binance`, symbol gateway (`BTCUSDT`), depth setting saat ini;
- symbol dinormalisasi uppercase dan harus sama dengan market gateway;
- depth dikonversi `Number`, dibulatkan, lalu dibatasi 10–200;
- `schemaVersion` dan `market` dikirim client resmi tetapi diabaikan server;
- success mengirim `subscribed`, snapshot, lalu `status`;
- market unsupported mengirim `error` dan client tetap tidak subscribed.

Payload `subscribed`:

```json
{
  "clientId": "<process-local id>",
  "exchange": "binance",
  "symbol": "BTCUSDT",
  "depth": 80,
  "source": "binance"
}
```

#### Unsubscribe

```json
{
  "type": "unsubscribe",
  "schemaVersion": 1,
  "exchange": "binance",
  "symbol": "BTCUSDT"
}
```

Server mengabaikan exchange/symbol, mengubah `subscribed=false`, lalu mengirim:

```json
{"exchange":"binance","symbol":"BTCUSDT"}
```

sebagai payload envelope `unsubscribed`.

#### Request snapshot

```json
{
  "type": "request_snapshot",
  "schemaVersion": 1,
  "exchange": "binance",
  "symbol": "BTCUSDT"
}
```

Server type hanya mensyaratkan `type`. Field lain diabaikan. Jika subscribed dan
book valid, server mengirim snapshot sesuai depth client lalu status valid yang
checkpoint/session-nya sama. Jika book belum valid, server hanya mengirim status
frozen. Jika belum subscribed, tidak ada response.

#### Ping

```json
{"type":"ping","schemaVersion":1,"timestamp":1787580672000}
```

Server selalu merespons envelope `heartbeat` dengan payload:

```json
{
  "clientId": "<process-local id>",
  "echoTimestamp": 1787580672000,
  "uptimeMs": 12500
}
```

Jika timestamp tidak dikirim, `echoTimestamp` adalah `null`.

#### Invalid messages

| Kondisi | `error.data.code` | Message |
|---|---|---|
| JSON tidak valid | `INVALID_JSON` | `WebSocket message must be valid JSON` |
| Object/type string tidak ada | `INVALID_MESSAGE` | `Message type is required` |
| Exchange/symbol subscribe tidak didukung | `UNSUPPORTED_MARKET` | hanya market MVP tersedia |
| Type lain | `UNKNOWN_MESSAGE` | daftar empat message yang didukung |

Server tidak menutup connection untuk error tersebut. Karena runtime validation
parsial, `symbol` non-string pada subscribe dapat melempar ketika
`.toUpperCase()` dipanggil; ini bukan error response yang terjamin.

### 4.3 Backpressure

- Jika `socket.bufferedAmount > 1 MiB`, event `depth_frame`, `metric`, dan `price`
  untuk client tersebut di-drop dan `droppedFrames` bertambah.
- Jika `bufferedAmount > 8 MiB`, socket ditutup dengan code 1013 dan reason
  `Client cannot keep up with market data`.
- `snapshot`, `trade_bucket`, `trend_signal`, status, dan control event tidak
  termasuk daftar drop 1 MiB.

## 5. Server event catalog

`ServerEventType` saat ini mendeklarasikan:

```text
snapshot, depth_frame, trade_bucket, price, metric, trend_signal,
status, heartbeat, error, subscribed, unsubscribed, replay_frame, market_reset
```

`replay_frame` belum pernah diproduksi dan tidak memiliki payload contract.

### 5.1 `snapshot`

```ts
interface SnapshotData {
  lastUpdateId: number;
  tickSize: number;
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
  source: "binance" | "demo";
  valid: boolean;
  frozen: boolean;
  sessionId: string;
  checkpoint: BookCheckpoint | null;
}
```

- Bids terurut price descending, asks ascending.
- Subscription/on-demand/REST depth dibatasi 10–200 level per side.
- Snapshot spontan dari feed dibentuk dengan maksimum 200 level, lalu dipotong
  per depth client ketika broadcast.
- Snapshot tidak membawa `bestBid`, `bestAsk`, `midPrice`, `spread`, atau
  `stale`, tetapi membawa validity epoch dan SHA-256 book checkpoint.
- Snapshot spontan feed memiliki envelope `exchangeTimestamp`; snapshot dari
  `getSnapshot` (subscribe, request, dan REST) tidak memilikinya.

Contoh payload dari nilai default/demo:

```json
{
  "lastUpdateId": 1,
  "tickSize": 0.1,
  "bids": [[63999.9, 0.956], [63999.8, 1.845]],
  "asks": [[64000.1, 0.923], [64000.2, 1.781]],
  "source": "demo"
}
```

Contoh menampilkan subset level untuk keterbacaan; server normal meminta minimal
10 level.

### 5.2 `depth_frame`

```ts
interface DepthFrameData {
  lastUpdateId: number;
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
  bestBid: number | null;
  bestAsk: number | null;
  midPrice: number | null;
  spread: number | null;
  stale: boolean;
  source: "binance" | "demo";
}
```

Gateway membangun full-state frame pada interval default 100 ms hanya setelah
book pernah menerima snapshot. `lastUpdateId` adalah book sequence, bukan
envelope sequence. Frame dibuat sampai 200 level per side lalu dipotong sesuai
depth client. `exchangeTimestamp` envelope adalah timestamp exchange dari raw
snapshot/depth/trade terakhir yang diproses dan dapat sama pada beberapa frame.

### 5.3 `trade_bucket`

```ts
interface TradeBucketData {
  bucketStart: number;
  bucketEnd: number;
  price: number;
  side: "buy" | "sell";
  volume: number;
  tradeCount: number;
  vwap: number;
  maxTrade: number;
  buyVolume: number;
  sellVolume: number;
  totalVolume: number;
  delta: number;
  source: "binance" | "demo";
}
```

Bucket key adalah `(floor(exchangeTimestamp / bucketMs), rounded price tick,
aggressor side)`. Default `bucketMs=250`; range setting 100–2.000 ms. Karena side
bagian dari key, satu bucket event hanya memiliki buy volume atau sell volume:

- buy: `buyVolume=volume`, `sellVolume=0`, `delta=volume`;
- sell: `buyVolume=0`, `sellVolume=volume`, `delta=-volume`;
- `totalVolume=volume`;
- `vwap=sum(rawPrice*quantity)/volume`;
- `exchangeTimestamp` envelope sama dengan `bucketEnd`.

Bucket hanya di-flush setelah `bucketEnd <= Date.now()` pada frame timer.

### 5.4 `price`

```ts
interface PriceData {
  price: number;
  quantity: number;
  side: "buy" | "sell";
  source: "binance" | "demo";
}
```

Ini adalah raw normalized trade yang di-throttle berdasarkan
`receivedTimestamp`: paling cepat satu publish setiap 50 ms. Trade id dan
received timestamp tidak ikut dikirim. Envelope `exchangeTimestamp` adalah trade
timestamp.

Contoh event yang dihasilkan demo:

```json
{
  "type": "price",
  "schemaVersion": 1,
  "exchange": "binance",
  "symbol": "BTCUSDT",
  "serverTimestamp": 1787580672831,
  "exchangeTimestamp": 1787580672830,
  "sequence": 7,
  "data": {
    "price": 63999.8,
    "quantity": 0.06830269194790024,
    "side": "sell",
    "source": "demo"
  }
}
```

### 5.5 `metric`

```ts
interface MetricData {
  lastPrice: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  delta: number;
  cvd: number;
  buyVolume: number;
  sellVolume: number;
  buySellRatio: number;
  imbalance: number;
  tradeRate: number;
  volumeRatio: number;
  momentumShort: number;
  momentumMedium: number;
  latencyMs: number | null;
  stale: boolean;
}
```

Semantik implementasi:

- `buyVolume`, `sellVolume`, dan `delta`: rolling trade window 5 detik;
- `cvd`: cumulative sejak analytics engine dibuat/reset;
- `buySellRatio`: buy/sell, `99` bila hanya buy, `1` bila tidak ada volume;
- `imbalance`: `(bidQty-askQty)/(bidQty+askQty)` pada 20 level terdekat;
- `tradeRate`: jumlah trade 5 detik dibagi 5;
- `volumeRatio`: volume 5 detik dibanding median volume per-second pada bagian
  historis rolling 30 detik; fallback `1` jika sample historis < 3;
- `momentumShort`/`momentumMedium`: perubahan relatif dari trade pertama pada
  window 5/30 detik terhadap last price;
- `latencyMs`: `Date.now() - lastTrade.receivedTimestamp`, atau `null` sebelum
  ada trade;
- numeric output tertentu dibulatkan oleh analytics engine; floating spread
  tetap dapat memperlihatkan artifact IEEE-754.

Contoh sebelum trade pertama:

```json
{
  "lastPrice": null,
  "bestBid": 63999.9,
  "bestAsk": 64000.1,
  "spread": 0.19999999999708962,
  "delta": 0,
  "cvd": 0,
  "buyVolume": 0,
  "sellVolume": 0,
  "buySellRatio": 1,
  "imbalance": 0.01783,
  "tradeRate": 0,
  "volumeRatio": 0,
  "momentumShort": 0,
  "momentumMedium": 0,
  "latencyMs": null,
  "stale": false
}
```

### 5.6 `trend_signal`

```ts
interface TrendSignalData {
  direction: "up" | "down" | "neutral";
  score: number;
  upScore: number;
  downScore: number;
  confidence: number;
  active: boolean;
  strength: "neutral" | "forming" | "strong" | "very_strong";
  reasons: string[];
  since: number | null;
}
```

- Score berada 0–100 dan confidence 0–1.
- Strength: `<40 neutral`, `40–59 forming`, `60–79 strong`, `>=80 very_strong`.
- Default enter threshold 65 selama tiga frame kandidat; default exit threshold
  50 selama dua frame.
- `direction` dapat menunjukkan kandidat mulai score 40 meski `active=false`.
- `since` adalah `Date.now()` frame ketika kandidat menjadi active; bukan
  timestamp exchange.
- Jika data stale, book belum synchronized, atau trade 5 detik kurang dari dua,
  detector reset dan mengirim signal neutral/inactive.

### 5.7 `status`

```ts
interface StatusData {
  state:
    | "connecting" | "syncing" | "live" | "reconnecting"
    | "demo" | "stale" | "error" | "closed";
  source: "binance" | "demo";
  message: string;
  stale: boolean;
  resyncCount: number;
  lastEventTimestamp: number | null;
  validity: "invalid" | "syncing" | "valid" | "stale" | "closed";
  transportAlive: boolean;
  marketActive: boolean;
  synchronized: boolean;
  frozen: boolean;
  reason: string;
  sessionId: string;
  lastValidAt: number | null;
  counters: DataQualityCounters;
  clockDriftMs: number | null;
  checkpoint: BookCheckpoint | null;
}
```

Envelope status tidak membawa `exchangeTimestamp`. `lastEventTimestamp` tidak
memiliki satu semantik exchange-time: status feed Binance mengisinya dengan local
time message/pong terakhir; status stale gateway mengisinya dengan local
`receivedTimestamp` market event terakhir; demo mengisinya dengan `Date.now()`.

State `idle` hanya lokal frontend. Server memproduksi `closed` saat graceful
shutdown sebelum socket ditutup.

### 5.8 `heartbeat`

Periodic heartbeat untuk client subscribed:

```ts
interface PeriodicHeartbeatData {
  clientId: string;
  uptimeMs: number;
  droppedFrames: number;
}
```

Application ping response:

```ts
interface PingHeartbeatData {
  clientId: string;
  echoTimestamp: unknown | null;
  uptimeMs: number;
}
```

`echoTimestamp` secara TypeScript dimaksudkan number, tetapi runtime menyalin
field JSON tanpa validasi. Kedua variant tidak memiliki envelope
`exchangeTimestamp`.

### 5.9 `error`, `subscribed`, and `unsubscribed`

```ts
interface ErrorData { code: string; message: string }
```

Payload subscribed/unsubscribed sudah dijelaskan pada client messages. Event
control ini tidak dinormalisasi menjadi `MarketDataEvent` oleh frontend, tetapi
metadata envelope sequence tetap dibaca sebelum event diabaikan.

### 5.10 `market_reset`

`market_reset` menandai pergantian validity epoch/source atau shutdown. Payload
membawa `sessionId`, optional `previousSessionId`, `reason`, dan `frozen`.
Frontend membersihkan seluruh depth/trade/price buffer, metric, dan trend ketika
event ini diterima, lalu menunggu snapshot dan status valid sesi baru.

### 5.11 Timestamp presence by event

| Event | `serverTimestamp` | Envelope `exchangeTimestamp` |
|---|---|---|
| feed `snapshot` | creation time | snapshot field (Binance adapter memakai local fetch time) |
| requested/REST `snapshot` | creation time | omitted |
| `depth_frame` | frame time | last processed raw market timestamp |
| `trade_bucket` | publish time | `bucketEnd` |
| `price` | publish time | trade exchange time |
| `metric`, `trend_signal` | frame time | last processed raw market timestamp |
| `status`, `heartbeat`, control/error | creation time | omitted |
| `market_reset` | creation time | omitted |

## 6. REST API

Semua route `/api/v1` berbagi rate limit in-memory 240 request per 60 detik per
`request.ip`/remote address. Tidak ada authentication. Response error umum:

```json
{
  "schemaVersion": 1,
  "error": {"code": "INVALID_RANGE", "message": "from must be before to"},
  "serverTimestamp": 1787580672000
}
```

Code yang digunakan: `INVALID_RANGE`, `INVALID_SETTINGS`,
`UNSUPPORTED_MARKET`, `REPLAY_NOT_FOUND`, `NOT_FOUND`, `RATE_LIMITED`, dan
`INTERNAL_ERROR`.

### 6.1 `GET /api/v1/health`

Status `200`:

```ts
interface HealthResponse {
  ok: boolean;
  schemaVersion: 1;
  serverTimestamp: number;
  uptimeSeconds: number;
  source: "binance" | "demo";
  status: StatusData;
  memory: { rssBytes: number; heapUsedBytes: number };
}
```

`ok` hanya false ketika `status.state === "error"`; state stale, reconnecting,
atau syncing tetap `ok=true`. Endpoint ini belum membedakan liveness dan
readiness.

### 6.2 `GET /api/v1/markets`

Status `200`:

```json
{
  "schemaVersion": 1,
  "markets": [{
    "exchange": "binance",
    "symbol": "BTCUSDT",
    "displaySymbol": "BTC/USDT Perpetual",
    "marketType": "perpetual",
    "tickSize": 0.1,
    "quantityStep": 0.001,
    "source": "binance",
    "available": true
  }]
}
```

`symbol`, `tickSize`, dan source berasal dari gateway. `displaySymbol`,
`marketType`, dan `quantityStep` literal seperti contoh, sehingga tidak aman
untuk gateway custom symbol.

### 6.3 `GET /api/v1/snapshot`

Query:

| Field | Default | Behavior |
|---|---|---|
| `exchange` | `binance` | lowercase, venue lain -> 404 `UNSUPPORTED_MARKET` |
| `symbol` | gateway symbol | uppercase, simbol lain -> 404 |
| `depth` | `visibleDepth` setting | Number + round + clamp 10–200; invalid -> default |

Status `200` adalah envelope `snapshot` pada bagian 5.1. Panggilan endpoint ini
menambah global envelope sequence walaupun event tidak dibroadcast ke WebSocket.
Envelope tidak memiliki `exchangeTimestamp`.

### 6.4 `GET /api/v1/history`

Query market sama dengan snapshot, ditambah:

| Field | Default | Behavior |
|---|---|---|
| `from` | now - 5 menit | finite numeric string/number atau date string yang dapat diparse |
| `to` | now | aturan sama dengan `from` |
| `resolution` | `1s` | `1s`, `5s`, `15s`, `1m`, `5m`, atau numeric |

Jika `from > to`, response `400 INVALID_RANGE`. Timestamp invalid diam-diam
memakai default. Response:

```ts
interface HistoryResponse {
  schemaVersion: 1;
  exchange: "binance";
  symbol: string;
  from: number;
  to: number;
  resolutionMs: number;
  items: HistoryPoint[];
}

interface HistoryPoint {
  timestamp: number;
  price: number | null;
  volume: number;
  delta: number;
  cvd: number;
  imbalance: number;
  trendScore: number;
  trendDirection: "up" | "down" | "neutral";
}
```

History source adalah ring buffer 21.600 point. Gateway menambahkan paling banyak
sekitar satu point per detik selama process hidup. Point 1 detik menyimpan latest
metric, termasuk rolling 5-second volume dan delta.

Resolution efektif dipilih yang paling dekat dari
`[1000, 5000, 15000, 60000, 300000]`. Untuk resolution > 1 detik:

- bucket timestamp adalah floor ke resolution;
- price, CVD, score, dan direction mengambil point terakhir;
- volume dan delta dijumlahkan;
- imbalance dirata-rata.

Kontrak response saat ini memiliki mismatch: `resolutionMs` mengulang nilai
hasil parse query sebelum nearest-resolution normalization. Contoh numeric
`7000` dilayani sebagai bucket 5000 ms tetapi response menulis
`"resolutionMs":7000`.

### 6.5 `GET /api/v1/settings`

Status `200`:

```json
{
  "schemaVersion": 1,
  "settings": {
    "frameIntervalMs": 100,
    "bubbleBucketMs": 250,
    "visibleDepth": 80,
    "staleAfterMs": 3000,
    "demoFallbackAfterMs": 4000,
    "trendEnterScore": 65,
    "trendExitScore": 50
  }
}
```

### 6.6 `PUT /api/v1/settings`

Body harus JSON object. Semua field optional tetapi value field yang dikenal
harus finite number. Unknown fields diabaikan. Nilai dibulatkan dan dibatasi:

| Setting | Min | Max |
|---|---:|---:|
| `frameIntervalMs` | 50 | 1.000 |
| `bubbleBucketMs` | 100 | 2.000 |
| `visibleDepth` | 10 | 200 |
| `staleAfterMs` | 1.000 | 30.000 |
| `demoFallbackAfterMs` | 1.000 | 30.000 |
| `trendEnterScore` | 50 | 95 |
| `trendExitScore` | 20 | 80 |

Jika exit >= enter setelah clamp, exit diubah menjadi
`max(20, enter - 10)`. Response `200` sama dengan GET settings. Body bukan object
atau known field non-finite menghasilkan `400 INVALID_SETTINGS`.

Perubahan bucket time membuat `TradeAggregator` baru dan membuang partial
bucket. Perubahan threshold trend membuat `AnalyticsEngine` baru dan menghapus
CVD/rolling state. Perubahan frame interval me-restart timer bila gateway aktif.

### 6.7 `POST /api/v1/replay/session`

Body optional:

```ts
interface ReplaySessionRequest {
  from?: number | parseableDateString;
  to?: number | parseableDateString;
  speed?: number;
  resolution?: "1s" | "5s" | "15s" | "1m" | "5m" | number;
}
```

Body non-object diperlakukan `{}` setelah JSON parser. Default `to=now`,
`from=to-5 menit`, `speed=1`, dan resolution 1 detik. Invalid optional timestamp
diam-diam dianggap absent. Speed dibatasi 0.25–20. `from > to` tidak ditolak dan
menghasilkan frame array kosong.

Runtime mengonversi `speed` dengan `Number`, sehingga numeric string diterima
dan `null`/string kosong menjadi 0 lalu di-clamp ke 0.25. `resolution` numeric
string juga diterima; JSON top-level primitive ditolak lebih dahulu oleh strict
body parser, sedangkan array masuk route dan diperlakukan sebagai body kosong.

Status `201`:

```ts
interface ReplaySessionCreated {
  schemaVersion: 1;
  session: {
    id: string;
    symbol: string;
    from: number;
    to: number;
    speed: number;
    frameCount: number;
    expiresAt: number;
    framesUrl: string;
  };
}
```

`id` adalah UUID, `expiresAt=createdAt+30 menit`, dan `framesUrl` berbentuk
`/api/v1/replay/session/{id}`. Session/frames hanya berada di RAM.

### 6.8 `GET /api/v1/replay/session/:id`

Status `200`:

```ts
interface ReplaySessionResponse {
  schemaVersion: 1;
  session: {
    id: string;
    symbol: string;
    from: number;
    to: number;
    speed: number;
    createdAt: number;
    expiresAt: number;
    frames: HistoryPoint[];
  };
}
```

Session absent/expired menghasilkan `404 REPLAY_NOT_FOUND`. Cleanup map berjalan
setiap 60 detik, tetapi lookup juga memeriksa expiry sehingga session tidak dapat
dibaca setelah `expiresAt` meski entry belum dibersihkan.

### 6.9 Other API paths and JSON errors

Path lain di bawah `/api` menghasilkan `404 NOT_FOUND`. Express JSON body limit
adalah 64 KiB dan strict JSON aktif. Error parser/body yang tidak ditangani route
masuk ke generic error middleware dan saat ini dikirim sebagai
`500 INTERNAL_ERROR`, bukan error parse khusus 400.

## 7. Official frontend normalization

Browser tidak meneruskan envelope langsung ke component. `normalizeMarketEvent`
mengubahnya menjadi flattened UI event.

### 7.1 Accepted producer aliases

| Wire type | UI type |
|---|---|
| `snapshot`, `depth_frame` | `depth_frame` |
| `trade`, `trade_bucket` | `trade_bucket` |
| `price` | `price` |
| `metrics`, `metric` | `metric` |
| `trend`, `trend_signal` | `trend_signal` |
| `status` | `status` |
| `heartbeat`, `pong` | `heartbeat` |
| `market_reset` | `market_reset` |

`subscribed`, `unsubscribed`, `error`, `replay_frame`, dan unknown event menjadi
`null` bagi market-data consumer. Alias singular/legacy di tabel diterima client
tetapi tidak diproduksi gateway saat ini.

Normalizer juga menerima:

- root `event` sebagai alias `type`;
- snake_case untuk banyak field;
- numeric string untuk number;
- level tuple atau object `{price, quantity}` dan alias pendek;
- timestamp detik, milidetik, mikrodetik, atau nanodetik lalu mengubahnya ke ms;
- flat payload tanpa `data`.

Missing envelope `exchangeTimestamp` diisi dari timestamp data lalu
`serverTimestamp`; missing `serverTimestamp` diisi local receive time. Missing
`schemaVersion` menjadi 1. Versi lain tidak ditolak. Exchange/symbol missing
menjadi `unknown`.

Snapshot dinormalisasi sebagai `type="depth_frame"`; best bid/ask/mid/spread
dihitung jika field tidak ada. Karena snapshot server tidak memiliki `stale`,
hasil normalisasi selalu `stale=false`.

### 7.2 Client delivery recovery

Frontend tidak memakai global `sequence` sebagai bukti kontinuitas. Jika
`streamId` dan `deliverySequence` tersedia, gap mengubah local status menjadi
syncing/stale dan meminta snapshot paling banyak sekali per detik. Envelope
pemicu gap, duplicate, dan posisi delivery yang mundur dibuang.

Selama recovery, derived market event dibuang. Snapshot boleh mengganti book,
tetapi freeze baru dilepas setelah status berikutnya memiliki seluruh proof
eksplisit: `validity=valid`, transport/market aktif, synchronized, dan
`frozen=false`. Metadata yang hilang atau malformed bersifat fail-closed.

### 7.3 Client buffers

Default hook capacity adalah 900 depth frame, 2.500 trade bucket, dan 4.000 price
tick. `App.tsx` override menjadi 1.800, 2.500, dan 3.000. Metric, trend, dan status
hanya menyimpan latest item.

Heartbeat tidak diteruskan ke hook. `heartbeat.droppedFrames` juga tidak ada pada
tipe frontend. `metric.latencyMs=null` dari server dinormalisasi menjadi `0`
karena normalizer memakai numeric fallback non-negative.

## 8. Current replay behavior

Remote replay browser masih memakai derived history. Browser:

1. membuat session lewat REST;
2. mengambil array `HistoryPoint`;
3. untuk setiap point, mengingat last non-null price;
4. merekonstruksi buy/sell volume dari `volume` dan delta yang di-clamp ke
   `[-volume, volume]`;
5. membuat synthetic `trade_bucket` dan `price` bila price tersedia;
6. membuat `metric` dan `trend_signal`; tidak membuat `depth_frame`;
7. memberikan sequence lokal baru untuk setiap synthetic event.

Trade count synthetic adalah 1 bila volume > 0; max trade sama dengan volume;
trade rate, volume ratio, momentum, dan latency adalah 0. Trend reasons dibuat
dari tanda delta dan imbalance. `active` dihitung ulang dari direction dan score
>= 65. Ini bukan payload live asli.

`ReplayController` menyortir event berdasarkan `event.timestamp`, lalu urutan
input asli untuk timestamp sama. Timer default 25 ms dan speed 0.1–20 hanya
mengubah replay clock. Seek memakai binary lower bound. Ketika seek mundur,
`useMarketData` membersihkan buffer; ketika seek maju, controller mengubah index
tanpa merekonstruksi state event sebelum cursor.

Built-in UI replay adalah dataset client terpisah dan dapat memuat depth frame;
ia bukan output REST replay session.

Fase 2 menambahkan API raw replay terpisah untuk katalog capture, verification,
session pause/resume/seek/speed, serta bounded frame pages. Frame REST raw hanya
mengekspos metadata/checksum audit dan belum dikonsumsi UI. Full capture dapat
diproyeksikan melalui production `OrderBook`; seek API belum melakukan
snapshot pre-roll untuk mengembalikan full book pada target.

## 9. Data invariants visible to consumers

- Depth frame adalah full top-N state, bukan delta.
- Bids descending dan asks ascending setelah keluar dari `OrderBook` maupun
  frontend normalizer.
- Quantity server-to-client selalu > 0; delete delta tidak diekspos ke browser.
- `bestBid`, `bestAsk`, mid, dan spread mengikuti full book, bukan semata level
  setelah client trim.
- Source/validity switch mereset book, analytics, dan partial trade buckets pada
  gateway serta seluruh projection buffer pada frontend.
- `stale=true` ketika gateway tidak menerima market event lebih lama dari
  `staleAfterMs` default 3 detik. Client memiliki detector terpisah default 5
  detik.
- Trend input dianggap valid hanya ketika book synchronized, tidak stale, dan
  ada minimal dua trade dalam rolling 5 detik.
- `status.state="live"` menyatakan feed synchronized; REST health `ok=true`
  memiliki arti lebih longgar.
- Envelope order pada satu socket mengikuti urutan `socket.send`, tetapi angka
  envelope sequence tidak kontinu bagi socket tersebut.

## 10. Compatibility policy

### Implemented behavior today

- Producer selalu menulis `schemaVersion: 1`.
- Server tidak mensyaratkan atau menolak versi inbound.
- Frontend menerima versi berapa pun, dan memakai 1 jika field hilang.
- Frontend mengabaikan event type yang tidak dikenali dan toleran terhadap field
  tambahan/alias.
- Tidak ada JSON Schema, content negotiation, WS subprotocol, deprecation header,
  atau contract test lintas versi.

### Normative policy for future changes

Sesuai ADR 0002:

- optional additive field/event dapat tetap v1;
- rename/remove, perubahan unit/arti/requiredness, atau perubahan enum yang
  mempersempit consumer memerlukan v2;
- producer dan consumer harus menolak major version unsupported secara
  terstruktur;
- v2 dilayani paralel pada `/api/v2` dan endpoint/subprotocol WS eksplisit selama
  migration;
- raw storage mencatat schema, adapter, dan analytics version;
- perubahan harus memiliki producer/consumer contract test dan migration note.

## 11. Contract status and residual risks

Tabel ini adalah hasil audit kode, bukan daftar fitur hipotetis.

| ID | Severity | Mismatch | Current impact |
|---|---|---|---|
| EVT-001 | Resolved F1 | Global `sequence` informasional; delivery counter scoped per koneksi | Contract test mencegah false gap akibat global jump |
| EVT-002 | Resolved F1 | Venue sequence divalidasi backend; client memakai validity epoch + delivery recovery | Gap memicu atomic resync dan signal freeze |
| EVT-003 | Resolved F1 | Snapshot membawa validity/session/checkpoint dan wajib diikuti status valid | Snapshot saja tidak membuka freeze |
| EVT-004 | Partial F2 | API raw replay dan deterministic book projection tersedia; UI/seek full-state belum terhubung | Audit raw dapat diulang, tetapi historical heatmap belum identik dengan live |
| EVT-005 | Resolved F1 | Gateway membekukan session dan hanya swap candidate book atomik | Frame/signal invalid tidak dipublikasikan sebagai valid |
| EVT-006 | P0 | `schemaVersion` inbound/consumer tidak divalidasi | Breaking producer/client mismatch dapat diterima diam-diam |
| EVT-007 | P1 | Subscribe hanya divalidasi sebagian; symbol non-string dapat melempar | Malformed client tidak selalu menerima structured error |
| EVT-008 | Resolved F1 | Feed hanya mengekspos final reconciled snapshot | Tidak ada intermediate book di wire |
| EVT-009 | P1 | Binance REST snapshot local fetch time dinamai `exchangeTimestamp` | Clock drift/latency analysis snapshot dapat salah arti |
| EVT-010 | Resolved F2 | Requested resolution dinormalisasi ke 1s/5s/1m sebelum query dan response | Label response mengikuti bucket efektif |
| EVT-011 | Resolved F2 | Metric persistence menyimpan buy/sell fakta interval dan rollup menjumlahkannya | Trade tidak dihitung berulang pada resolusi lebih besar |
| EVT-012 | P1 | Server `metric.latencyMs=null` menjadi `0` di frontend | "Belum ada trade" terlihat seperti zero latency |
| EVT-013 | P1 | `GET /markets` display/quantity metadata hardcoded BTC | Metadata salah bila gateway dibuat untuk simbol lain |
| EVT-014 | P2 | Periodic `droppedFrames` di heartbeat dibuang frontend | User/telemetry client tidak melihat degraded delivery |
| EVT-015 | P2 | `replay_frame` dideklarasikan tanpa producer/payload/consumer | Tipe memberi kesan kontrak yang belum ada |
| EVT-016 | P2 | Client menerima alias dan schema version arbitrary tanpa mencatatnya | Contract drift sulit diamati |
| EVT-017 | P2 | JSON parse/body errors REST menjadi generic 500 | Client tidak dapat membedakan invalid request dari server failure |
| EVT-018 | P1 | UI `timeBucketMs` mengubah cell width tanpa mengagregasi depth frame | Label bucket dapat memberi kesan resolusi data yang tidak benar dan draw work tetap besar |

Urutan perbaikan mengikuti P0 lalu P1. Memperbaiki dokumentasi saja tidak
menutup item; masing-masing memerlukan test yang membuktikan perilaku wire.

## 12. Implementation sources

Inventory ini diturunkan langsung dari:

- `server/types.ts`
- `server/feeds/binanceFeed.ts`
- `server/feeds/demoFeed.ts`
- `server/core/orderBook.ts`
- `server/core/tradeAggregator.ts`
- `server/core/analytics.ts`
- `server/marketGateway.ts`
- `server/httpServer.ts`
- `src/types/market.ts`
- `src/types/replay.ts`
- `src/lib/marketNormalization.ts`
- `src/lib/marketDataClient.ts`
- `src/lib/replayApi.ts`
- `src/lib/replayController.ts`
- `src/lib/useMarketData.ts`
