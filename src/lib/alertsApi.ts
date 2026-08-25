/** Phase 5 REST client for the alert surface (`/api/v1/alerts/*`). */

export type AlertKind = 'trend_score' | 'liquidity_wall' | 'volume_delta' | 'trade_velocity';

export interface AlertRule {
  id: string;
  symbol: string;
  kind: AlertKind;
  thresholdMode: 'baseline' | 'absolute';
  multiplier?: number;
  absoluteValue?: number;
  op?: 'above' | 'below';
  wallState?: 'appeared' | 'disappeared';
  cooldownMs: number;
  sound: boolean;
  enabled: boolean;
  createdBy?: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface AlertBaseline {
  symbol: string;
  metric: string;
  samples: number;
  median: number | null;
}

export interface AlertRulesResponse {
  rules: AlertRule[];
  shadowMode: boolean;
  algoVersion: string;
  horizonsMs: number[];
  baselines: AlertBaseline[];
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const payload = (await response.json()) as { error?: { message?: string } };
      if (payload.error?.message) message = payload.error.message;
    } catch {
      // Non-JSON error body keeps the status-code message.
    }
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function fetchAlertRules(): Promise<AlertRulesResponse> {
  return request<AlertRulesResponse>('/api/v1/alerts/rules');
}

export function createAlertRule(
  input: Omit<AlertRule, 'id' | 'createdAtMs' | 'updatedAtMs' | 'createdBy'>,
): Promise<{ rule: AlertRule }> {
  return request<{ rule: AlertRule }>('/api/v1/alerts/rules', {
    method: 'POST',
    body: JSON.stringify({ ...input, createdBy: 'ui' }),
  });
}

export function updateAlertRule(id: string, patch: Partial<AlertRule>): Promise<{ rule: AlertRule }> {
  return request<{ rule: AlertRule }>(`/api/v1/alerts/rules/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function deleteAlertRule(id: string): Promise<void> {
  return request<void>(`/api/v1/alerts/rules/${encodeURIComponent(id)}`, { method: 'DELETE' });
}