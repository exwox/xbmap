// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DashboardErrorBoundary } from './DashboardErrorBoundary';

const mountedRoots: Array<ReturnType<typeof createRoot>> = [];

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('DashboardErrorBoundary', () => {
  it('contains a render failure and recovers through its action', () => {
    let broken = true;
    const recover = vi.fn(() => { broken = false; });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    function Dashboard() {
      if (broken) throw new Error('canvas failed');
      return <div>Dashboard restored</div>;
    }

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    mountedRoots.push(root);

    act(() => {
      root.render(
        <DashboardErrorBoundary onRecover={recover}>
          <Dashboard />
        </DashboardErrorBoundary>,
      );
    });

    expect(container.querySelector('[role="alert"]')?.textContent)
      .toContain('Visualisasi berhenti dengan aman');

    const button = container.querySelector('button');
    expect(button).not.toBeNull();
    act(() => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(recover).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('Dashboard restored');
  });
});
