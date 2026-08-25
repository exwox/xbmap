/** Phase 6 REST client for the session-auth foundation. */

export interface AuthStatus {
  required: boolean;
  authenticated: boolean;
  username?: string;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: { message?: string };
    retryInSeconds?: number;
  };
  if (!response.ok) {
    const suffix = payload.retryInSeconds ? ` (${payload.retryInSeconds}s)` : '';
    throw new Error(payload.error?.message ?? `HTTP ${response.status}${suffix}`);
  }
  return payload as T;
}

export function fetchAuthStatus(): Promise<AuthStatus> {
  return requestJson<AuthStatus>('/api/v1/auth/status');
}

export function login(
  username: string,
  password: string,
): Promise<{ authenticated: true; username: string }> {
  return requestJson('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

export function logout(): Promise<{ authenticated: false }> {
  return requestJson('/api/v1/auth/logout', { method: 'POST' });
}