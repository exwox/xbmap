# Definisi Evaluasi Trend Signal

Versi definisi: 1.0  
Status: diterima untuk baseline; bukan strategi trading

## 1. Unit evaluasi

Satu event evaluasi dibuat ketika trend state machine berpindah dari netral ke `active up` atau `active down` dengan score minimal 65 selama tiga frame konfirmasi.

Sinyal yang tetap aktif tidak dihitung ulang setiap frame. Sinyal baru hanya dibuat setelah state keluar di bawah threshold 50 dan kemudian masuk kembali.

Data yang disimpan pada waktu sinyal `t0`:

- symbol dan exchange;
- versi algoritma dan parameter;
- direction;
- score, confidence, dan reasons;
- mid-price, best bid, best ask, dan spread;
- delta, CVD, imbalance, volume ratio, dan trade rate;
- volatility regime;
- data-quality state.

Sinyal dengan book invalid, data stale, sequence gap aktif, atau spread di atas percentile 99 tidak masuk evaluasi utama dan diberi label `invalid_context`.

## 2. Horizon

Setiap sinyal dinilai pada horizon:

- 10 detik;
- 30 detik sebagai horizon utama;
- 60 detik;
- 300 detik.

Harga referensi adalah mid-price pada atau segera setelah horizon. Jika tidak tersedia dalam toleransi satu detik, outcome diberi label `missing_data`.

## 3. Return terarah

```text
directionSign = +1 untuk up, -1 untuk down
signedReturnBps(h) = directionSign × (mid(t0+h) - mid(t0)) / mid(t0) × 10.000
noiseThresholdBps = max(3 bps, 2 × spreadBps(t0))
```

Label outcome pada tiap horizon:

- `correct`: `signedReturnBps > noiseThresholdBps`;
- `wrong`: `signedReturnBps < -noiseThresholdBps`;
- `flat`: berada di antara dua threshold;
- `missing_data`: data tidak cukup atau tidak valid.

Outcome `flat` dilaporkan terpisah dan tidak boleh diam-diam dihitung sebagai kemenangan.

## 4. Excursion

Dalam rentang `t0` sampai horizon:

```text
MFE = pergerakan maksimum searah sinyal dalam basis point
MAE = pergerakan maksimum berlawanan arah sinyal dalam basis point
```

MFE dan MAE memakai mid-price agar evaluasi tidak mengklaim fill atau PnL yang tidak terjadi. Evaluasi strategi yang memakai bid/ask, fee, slippage, dan latency eksekusi adalah proyek terpisah.

## 5. Metrik utama

- directional precision: `correct / (correct + wrong)`;
- coverage: sinyal valid per jam;
- flat rate;
- missing-data rate;
- median dan percentile MFE/MAE;
- mean/median signed return per horizon;
- calibration per confidence bucket;
- hasil per symbol, hour, volatility regime, dan spread regime.

Recall hanya boleh dihitung setelah definisi ground-truth trend independen tersedia. Jangan menyebut jumlah sinyal yang berhasil sebagai recall.

## 6. Minimum sample

- Eksperimen awal: minimal 100 sinyal valid per simbol.
- Perbandingan versi: minimal 500 sinyal gabungan dan tidak kurang dari 100 per simbol.
- Klaim stabilitas: minimal empat minggu data yang mencakup lebih dari satu volatility regime.

Tidak ada threshold produksi yang dipilih hanya dari satu hari, satu simbol, atau fixture sintetis.

## 7. Acceptance awal

Trend engine dapat masuk beta shadow jika:

- replay deterministik menghasilkan sinyal identik;
- missing-data rate < 1%;
- seluruh sinyal memiliki reason dan algorithm version;
- directional precision 30 detik lebih baik dari baseline momentum sederhana pada sample yang sama;
- tidak ada sinyal aktif ketika data-quality invalid.

Target precision numerik tidak dikunci pada Fase 0 karena belum ada live sample yang cukup. Angka tersebut ditetapkan setelah capture dan shadow evaluation, bukan dipilih untuk menyesuaikan hasil.
