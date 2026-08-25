import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  createMarketHttpServer,
  type MarketHttpServer,
  type MarketHttpServerOptions,
} from "../httpServer.js";
import { MarketGateway } from "../marketGateway.js";
import { AuthService } from "../auth/authService.js";

function buildService(options: {
  requireAuth?: boolean;
  adminToken?: string;
} = {}): MarketHttpServer {
  let clock = 1_000_000;
  const auth = new AuthService(
    { sessionTtlMs: 60 * 60_000, now: () => clock },
    { username: "admin", password: "s3cret-pass" },
  );
  const init: MarketHttpServerOptions = {};
  if (options.adminToken) init.adminToken = options.adminToken;
  if (Object.keys(options).includes("requireAuth")) {
    init.auth = { service: auth, required: options.requireAuth === true };
  }
  return createMarketHttpServer(
    new MarketGateway({ forceDemo: true }),
    null,
    undefined,
    init,
  );
}

async function listen(service: MarketHttpServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    service.server.once("error", reject);
    service.server.listen(0, "127.0.0.1", resolve);
  });
  const address = service.server.address();
  if (typeof address === "object" && address) return address.port;
  throw new Error("listener did not bind");
}

/** Performs the login flow and returns the session cookie header value. */
async function loginCookie(port: number, password = "s3cret-pass"): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie");
  expect(cookie).toContain("xbmap_session=");
  return (cookie ?? "").split(";")[0]!;
}

describe("phase 6 hardening and auth surface", () => {
  let service: MarketHttpServer | null = null;

  afterEach(async () => {
    await service?.close();
    service = null;
  });

  async function started(options: { requireAuth?: boolean; adminToken?: string } = {}) {
    service = buildService(options);
    return listen(service);
  }

  // PHASE6_TESTS_MARKER

  it("sends a strict Content-Security-Policy on every response", async () => {
    const port = await started();
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/health/live`);
    const csp = response.headers.get("content-security-policy");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("guards metrics and observability routes with the admin token", async () => {
    const port = await started({ adminToken: "ops-secret" });
    const base = `http://127.0.0.1:${port}`;

    expect((await fetch(`${base}/metrics`)).status).toBe(401);
    expect((await fetch(`${base}/api/v1/observability/incidents`)).status).toBe(401);

    const viaHeader = await fetch(`${base}/metrics`, {
      headers: { "x-admin-token": "ops-secret" },
    });
    expect(viaHeader.status).toBe(200);
    expect(await viaHeader.text()).toContain("# TYPE");

    const viaBearer = await fetch(`${base}/api/v1/observability/incidents`, {
      headers: { authorization: "Bearer ops-secret" },
    });
    expect(viaBearer.status).toBe(200);
  });

  it("keeps metrics open for local tooling when no token is configured", async () => {
    const port = await started();
    expect((await fetch(`http://127.0.0.1:${port}/metrics`)).status).toBe(200);
  });

  it("enforces login on protected API routes and the WebSocket upgrade", async () => {
    const port = await started({ requireAuth: true });
    const base = `http://127.0.0.1:${port}`;

    // Health probes stay open; protected routes demand a session.
    expect((await fetch(`${base}/api/v1/health/ready`)).status).toBeLessThan(500);
    const denied = await fetch(`${base}/api/v1/markets`);
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ error: { code: "AUTH_REQUIRED" } });

    const status = (await (
      await fetch(`${base}/api/v1/auth/status`)
    ).json()) as { required: boolean; authenticated: boolean };
    expect(status).toMatchObject({ required: true, authenticated: false });

    const wrong = await fetch(`${base}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "wrong" }),
    });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ error: { code: "INVALID_CREDENTIALS" } });

    const cookie = await loginCookie(port);
    const allowed = await fetch(`${base}/api/v1/markets`, { headers: { cookie } });
    expect(allowed.status).toBe(200);

    // WS upgrade tanpa cookie ditolak dengan 401.
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      socket.on("error", (error: Error & { message?: string }) => {
        expect(error.message).toContain("401");
        resolve();
      });
      socket.on("open", () => {
        socket.close();
        reject(new Error("upgrade should have been denied"));
      });
    });

    const authedSocket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } });
    await new Promise<void>((resolve, reject) => {
      authedSocket.on("open", () => resolve());
      authedSocket.on("error", reject);
    });
    authedSocket.close();

    await fetch(`${base}/api/v1/auth/logout`, { method: "POST", headers: { cookie } });
    expect(
      (await fetch(`${base}/api/v1/markets`, { headers: { cookie } })).status,
    ).toBe(401);
  });
});
