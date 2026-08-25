import type {
  ConnectionState,
  StatusFrame,
  TrendSignal,
} from '../types/market';

export type DataQualityMode = 'live' | 'demo' | 'replay';
export type DataQualityCode =
  | 'valid'
  | 'waiting'
  | 'connecting'
  | 'syncing'
  | 'resyncing'
  | 'reconnecting'
  | 'inactive'
  | 'stale'
  | 'error'
  | 'offline';

export interface DataQualityInput {
  mode: DataQualityMode;
  status: Pick<
    StatusFrame,
    | 'state'
    | 'message'
    | 'stale'
    | 'resyncCount'
    | 'validity'
    | 'transportAlive'
    | 'marketActive'
    | 'synchronized'
    | 'frozen'
    | 'reason'
  >;
  isStale: boolean;
  hasBook: boolean;
  bookStale?: boolean;
}

export interface DataQualityAssessment {
  code: DataQualityCode;
  valid: boolean;
  label: string;
  reason: string;
  detail: string | null;
  tone: 'positive' | 'warning' | 'negative';
  action: 'snapshot' | 'reconnect' | null;
}

const RECOVERY_PATTERN = /gap|resync|reconcil|snapshot|sequence/i;

function statusDetail(message: string, fallback: string): string | null {
  const normalized = message.trim();
  if (!normalized || normalized.toLowerCase() === fallback.toLowerCase()) return null;
  return normalized;
}

function assessment(
  code: DataQualityCode,
  label: string,
  reason: string,
  statusMessage: string,
  tone: DataQualityAssessment['tone'],
  action: DataQualityAssessment['action'] = null,
): DataQualityAssessment {
  return {
    code,
    valid: code === 'valid',
    label,
    reason,
    detail: statusDetail(statusMessage, reason),
    tone,
    action,
  };
}

function recoveryState(
  state: ConnectionState,
  message: string,
  resyncCount: number,
): DataQualityAssessment | null {
  switch (state) {
    case 'idle':
      return assessment(
        'waiting',
        'MENUNGGU DATA',
        'Sumber data belum dimulai; menunggu snapshot order book.',
        message,
        'warning',
      );
    case 'connecting':
      return assessment(
        'connecting',
        'CONNECTING',
        'Transport sedang menghubungkan gateway; book belum dapat digunakan.',
        message,
        'warning',
      );
    case 'syncing': {
      const isResync = resyncCount > 0 || RECOVERY_PATTERN.test(message);
      return assessment(
        isResync ? 'resyncing' : 'syncing',
        isResync ? 'RESYNCING BOOK' : 'SYNCING BOOK',
        isResync
          ? 'Book dinonaktifkan sementara sampai snapshot dan urutan event tervalidasi.'
          : 'Snapshot awal sedang divalidasi sebelum book ditampilkan sebagai live.',
        message,
        'warning',
        isResync ? 'snapshot' : null,
      );
    }
    case 'reconnecting':
      return assessment(
        'reconnecting',
        'RECONNECTING',
        'Transport terputus; data lama dibekukan selama koneksi dipulihkan.',
        message,
        'warning',
        'reconnect',
      );
    case 'error':
      return assessment(
        'error',
        'CONNECTION ERROR',
        'Gateway melaporkan error; book dan sinyal tidak dapat dipercaya.',
        message,
        'negative',
        'reconnect',
      );
    case 'closed':
      return assessment(
        'offline',
        'OFFLINE',
        'Transport ditutup; tidak ada pembaruan market yang diterima.',
        message,
        'negative',
        'reconnect',
      );
    default:
      return null;
  }
}

/**
 * Converts transport, book, and replay state into one user-facing validity
 * decision. A green transport alone never makes an empty or stale book valid.
 */
export function assessDataQuality(input: DataQualityInput): DataQualityAssessment {
  const { mode, status } = input;
  const explicitReason = status.reason?.trim() || status.message;

  if (mode !== 'replay') {
    const recovering = recoveryState(status.state, explicitReason, status.resyncCount);
    if (recovering) return recovering;

    if (status.transportAlive === false) {
      return assessment(
        'reconnecting',
        'TRANSPORT DOWN',
        'Gateway aktif, tetapi transport market feed sedang terputus.',
        explicitReason,
        'negative',
        'reconnect',
      );
    }

    if (
      status.validity === 'syncing' ||
      status.synchronized === false ||
      status.frozen === true
    ) {
      return assessment(
        'resyncing',
        'RESYNCING BOOK',
        'Gateway membekukan book sampai rekonsiliasi sequence selesai.',
        explicitReason,
        'warning',
        'snapshot',
      );
    }

    if (status.validity === 'invalid') {
      return assessment(
        'error',
        'BOOK INVALID',
        'Gateway menandai book invalid; analytics dan sinyal dinonaktifkan.',
        explicitReason,
        'negative',
        'snapshot',
      );
    }

    if (status.validity === 'closed') {
      return assessment(
        'offline',
        'BOOK CLOSED',
        'Sesi validitas book telah ditutup dan harus dibuat ulang.',
        explicitReason,
        'negative',
        'reconnect',
      );
    }

    if (status.marketActive === false) {
      return assessment(
        'inactive',
        'MARKET INACTIVE',
        'Transport hidup, tetapi gateway belum melihat aktivitas market baru.',
        explicitReason,
        'warning',
      );
    }

    if (
      status.validity !== 'valid' ||
      status.transportAlive !== true ||
      status.marketActive !== true ||
      status.synchronized !== true ||
      status.frozen !== false
    ) {
      return assessment(
        'syncing',
        'QUALITY UNVERIFIED',
        'Gateway belum memberikan seluruh bukti validitas book yang diwajibkan.',
        explicitReason,
        'warning',
        'snapshot',
      );
    }
  }

  if (
    input.isStale ||
    input.bookStale ||
    status.stale ||
    status.state === 'stale' ||
    status.validity === 'stale'
  ) {
    return assessment(
      'stale',
      'DATA STALE',
      'Pembaruan market melewati batas waktu atau frame book ditandai stale.',
      explicitReason,
      'negative',
      mode === 'replay' ? null : 'snapshot',
    );
  }

  if (!input.hasBook) {
    return assessment(
      'waiting',
      'WAITING SNAPSHOT',
      mode === 'replay'
        ? 'Replay belum mencapai snapshot order book yang valid.'
        : 'Transport aktif, tetapi snapshot order book valid belum tersedia.',
      explicitReason,
      'warning',
      null,
    );
  }

  const sourceLabel = mode === 'replay' ? 'REPLAY VALID' : mode === 'demo' ? 'DEMO VALID' : 'VALIDATED';
  return assessment(
    'valid',
    sourceLabel,
    mode === 'replay'
      ? 'Snapshot replay tersedia dan tidak ditandai stale.'
      : 'Order book tersinkron dan aman digunakan oleh analytics.',
    explicitReason,
    'positive',
  );
}

/** Prevents a previously computed signal from resurfacing while book validity is unknown. */
export function validatedTrend(
  trend: TrendSignal | null,
  quality: Pick<DataQualityAssessment, 'valid'>,
): TrendSignal | null {
  return quality.valid ? trend : null;
}
