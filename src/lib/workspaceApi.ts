/** Phase 6 REST client: per-user workspace persistence + feature flags. */

export type FeatureFlags = Record<string, boolean>;

export async function fetchWorkspace(): Promise<{ username: string; workspace: Record<string, unknown> }> {
  const response = await fetch('/api/v1/workspace');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as { username: string; workspace: Record<string, unknown> };
}

export async function saveWorkspace(workspace: Record<string, unknown>): Promise<void> {
  const response = await fetch('/api/v1/workspace', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(workspace),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

export async function fetchFeatureFlags(): Promise<FeatureFlags> {
  const response = await fetch('/api/v1/feature-flags');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return ((await response.json()) as { flags: FeatureFlags }).flags;
}