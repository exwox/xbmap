import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  createMarketHttpServer,
  type MarketHttpServer,
  type MarketHttpServerOptions,
} from "../httpServer.js";
import { MarketGateway } from "../marketGateway.js";
import { AuthService } from "../auth/authService.js";
import { UserStore } from "../auth/userStore.js";

async function makeTempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "xbmap-users-"));
  return join(dir, "users.json");
}

function buildService(users: UserStore): MarketHttpServer {
  let clock = 1_000_000;
  const authService = new AuthService(
    {
      sessionTtlMs: 60 * 60_000,
      now: () => clock,
      verify: (username: string, password: string) =>
        users.verifyCredentials(username, password),
    },
  );
  const init: MarketHttpServerOptions = {
    auth: { service: authService, required: true },
    users,
  };
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

async function login(port: number, username: string, password: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  expect(response.status).toBe(200);
  return (response.headers.get("set-cookie") ?? "").split(";")[0]!;
}

// TESTS_MARKER

describe("user store", () => {
  it("persists users, workspaces, and flags across reopen", async () => {
    const file = await makeTempFile();
    const first = await UserStore.open({ filePath: file });
    expect(first.ensureBootstrapAdmin("admin", "bootstrap-pass")).toBe(true);
    first.createUser({ username: "viewer1", password: "viewer-pass-1", role: "viewer" });
    first.setWorkspace("viewer1", { watchlist: ["SOLUSDT"], visual: { depth: 40 } });
    first.setFlag("alerts_panel", true);
    await first.flush();

    const second = await UserStore.open({ filePath: file });
    expect(second.verifyCredentials("admin", "bootstrap-pass")).toBe(true);
    expect(second.verifyCredentials("viewer1", "viewer-pass-1")).toBe(true);
    expect(second.verifyCredentials("viewer1", "wrong-pass")).toBe(false);
    expect(second.roleOf("admin")).toBe("admin");
    expect(second.roleOf("viewer1")).toBe("viewer");
    expect(second.getWorkspace("viewer1")).toMatchObject({ watchlist: ["SOLUSDT"] });
    expect(second.getFlags().alerts_panel).toBe(true);

    second.createUser({ username: "viewer2", password: "viewer-pass-2" });
    expect(second.getWorkspace("viewer2")).toBeNull();
    await rm(file, { force: true });
  });

  it("rejects duplicates, disabled logins, and deletes workspaces on delete", async () => {
    const file = await makeTempFile();
    const store = await UserStore.open({ filePath: file });
    store.createUser({ username: "alice", password: "alice-pass-1" });
    expect(() => store.createUser({ username: "alice", password: "other-pass" }))
      .toThrow(/already exists/);

    store.setDisabled("alice", true);
    expect(store.verifyCredentials("alice", "alice-pass-1")).toBe(false);
    store.setDisabled("alice", false);
    expect(store.verifyCredentials("alice", "alice-pass-1")).toBe(true);

    store.setWorkspace("alice", { a: 1 });
    expect(store.deleteUser("alice")).toBe(true);
    expect(store.deleteUser("alice")).toBe(false);
    expect(store.getWorkspace("alice")).toBeNull();
    await rm(file, { force: true });
  });
});

describe("multi-user HTTP surface", () => {
  let service: MarketHttpServer | null = null;
  let users: UserStore | null = null;

  afterEach(async () => {
    await service?.close();
    service = null;
    users = null;
  });

  async function startedWithUsers(): Promise<number> {
    users = await UserStore.open({});
    users.ensureBootstrapAdmin("admin", "admin-pass-1");
    users.createUser({ username: "viewer", password: "viewer-pass", role: "viewer" });
    service = buildService(users);
    return listen(service);
  }

  it("separates admin management from viewer permissions", async () => {
    const port = await startedWithUsers();
    const base = `http://127.0.0.1:${port}`;
    const adminCookie = await login(port, "admin", "admin-pass-1");
    const viewerCookie = await login(port, "viewer", "viewer-pass");

    const created = await fetch(`${base}/api/v1/admin/users`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ username: "trader", password: "trader-pass", role: "viewer" }),
    });
    expect(created.status).toBe(201);

    const list = await fetch(`${base}/api/v1/admin/users`, {
      headers: { cookie: adminCookie },
    });
    const userList = (await list.json()) as { users: Array<{ username: string }> };
    expect(userList.users.map((entry) => entry.username))
      .toEqual(expect.arrayContaining(["admin", "viewer", "trader"]));

    const forbiddenList = await fetch(`${base}/api/v1/admin/users`, {
      headers: { cookie: viewerCookie },
    });
    expect(forbiddenList.status).toBe(403);

    const forbiddenCreate = await fetch(`${base}/api/v1/admin/users`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: viewerCookie },
      body: JSON.stringify({ username: "nope", password: "nope-pass-1" }),
    });
    expect(forbiddenCreate.status).toBe(403);

    const deleted = await fetch(`${base}/api/v1/admin/users/trader`, {
      method: "DELETE",
      headers: { cookie: adminCookie },
    });
    expect(deleted.status).toBe(204);
  });

  it("keeps per-user workspaces isolated and feature flags admin-only", async () => {
    const port = await startedWithUsers();
    const base = `http://127.0.0.1:${port}`;
    const adminCookie = await login(port, "admin", "admin-pass-1");
    const viewerCookie = await login(port, "viewer", "viewer-pass");

    const saved = await fetch(`${base}/api/v1/workspace`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: viewerCookie },
      body: JSON.stringify({ watchlist: ["ETHUSDT"], visual: { depth: 60 } }),
    });
    expect(saved.status).toBe(200);

    const viewerLoaded = (await (
      await fetch(`${base}/api/v1/workspace`, { headers: { cookie: viewerCookie } })
    ).json()) as { workspace: { watchlist?: string[] } };
    expect(viewerLoaded.workspace.watchlist).toEqual(["ETHUSDT"]);

    const adminLoaded = (await (
      await fetch(`${base}/api/v1/workspace`, { headers: { cookie: adminCookie } })
    ).json()) as { workspace: Record<string, unknown> };
    expect(adminLoaded.workspace).toEqual({});

    expect((await fetch(`${base}/api/v1/feature-flags`, {
      headers: { cookie: viewerCookie },
    })).status).toBe(200);

    expect((await fetch(`${base}/api/v1/feature-flags`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: viewerCookie },
      body: JSON.stringify({ alerts_panel: false }),
    })).status).toBe(403);

    const patched = await fetch(`${base}/api/v1/feature-flags`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ alerts_panel: false }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { flags: Record<string, boolean> }).flags.alerts_panel)
      .toBe(false);
  });

  it("blocks disabled accounts from logging in and upgrading WebSocket", async () => {
    const port = await startedWithUsers();
    users!.setDisabled("viewer", true);

    const response = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "viewer", password: "viewer-pass" }),
    });
    expect(response.status).toBe(401);

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      socket.on("error", () => resolve());
      socket.on("open", () => {
        socket.close();
        reject(new Error("disabled user should not upgrade"));
      });
    });
  });
});
