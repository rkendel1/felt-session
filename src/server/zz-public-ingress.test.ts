/**
 * public-ingress tests: the isolated public listener serves ONLY the sandbox
 * dial-back surface (run-ws/rpc-ws upgrades + /ingress-health), 404s all
 * other paths bodylessly, shares run-ws.ts's token auth, and rate-limits
 * upgrade attempts per client IP (X-Forwarded-For-aware behind a local
 * reverse proxy). No model runs, no sandboxes.
 *
 * zz- prefix: keeps this at the end of the full suite like the other
 * integration-ish test files (run-ws's module graph pins paths at load).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Deferred imports: public-ingress → run-ws → run-rpc → paths resolves
// OPENSESSION_SESSIONS_DIR/HOME at module load (see zz-run-ws.test.ts).
let ingress: typeof import("./public-ingress");
let runWs: typeof import("./run-ws");

let scratch = "";
let configPath = "";
let prevConfigEnv: string | undefined;
let handle: import("./public-ingress").PublicIngressHandle | null = null;
let BASE = "";

function writeConfig(cfg: unknown): void {
  writeFileSync(configPath, JSON.stringify(cfg));
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), "bks-ingress-"));
  configPath = join(scratch, "sandbox-config.json");
  prevConfigEnv = process.env.OPENSESSION_SANDBOX_CONFIG;
  process.env.OPENSESSION_SANDBOX_CONFIG = configPath;
  writeConfig({ provider: "local", publicIngress: { enabled: true } });
  ingress = await import("./public-ingress");
  runWs = await import("./run-ws");
  handle = ingress.startPublicIngress({ port: 0, host: "127.0.0.1" });
  if (!handle) throw new Error("ingress did not start");
  BASE = `127.0.0.1:${handle.port}`;
});

afterAll(() => {
  ingress?.stopPublicIngress();
  if (prevConfigEnv === undefined) delete process.env.OPENSESSION_SANDBOX_CONFIG;
  else process.env.OPENSESSION_SANDBOX_CONFIG = prevConfigEnv;
  rmSync(scratch, { recursive: true, force: true });
});

describe("public ingress surface", () => {
  test("/ingress-health answers a bare 200 ok", async () => {
    const res = await fetch(`http://${BASE}/ingress-health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("every other path is a bodyless 404 (no app surface)", async () => {
    for (const path of [
      "/",
      "/backstage/",
      "/api/sessions",
      "/api/health",
      "/ws",
      "/robots.txt",
    ]) {
      const res = await fetch(`http://${BASE}${path}`);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("");
    }
  });
});

describe("upgrade auth (shared with run-ws.ts)", () => {
  test("run-ws without a token is 403", async () => {
    ingress.resetPublicIngressRateLimit();
    const res = await fetch(`http://${BASE}/run-ws/rh-nope`, {
      headers: { upgrade: "websocket" },
    });
    expect(res.status).toBe(403);
  });

  test("run-ws with a garbage token is 403", async () => {
    runWs.registerRunWsHost("rh-ingress-auth", "right-token");
    try {
      const res = await fetch(
        `http://${BASE}/run-ws/rh-ingress-auth?token=garbage`,
        { headers: { upgrade: "websocket" } },
      );
      expect(res.status).toBe(403);
    } finally {
      runWs.unregisterRunWsHost("rh-ingress-auth");
    }
  });

  test("run-ws with the registered token upgrades (101) and acks", async () => {
    const hostId = "rh-ingress-ok";
    runWs.registerRunWsHost(hostId, "sekrit");
    try {
      const ws = new WebSocket(`ws://${BASE}/run-ws/${hostId}?token=sekrit`);
      const firstMsg = await new Promise<any>((resolve, reject) => {
        ws.onmessage = (ev) => resolve(JSON.parse(String(ev.data)));
        ws.onerror = () => reject(new Error("ws error"));
        setTimeout(() => reject(new Error("timeout")), 5000);
      });
      expect(firstMsg.t).toBe("ack"); // run-ws hello-ack — same machinery
      expect(runWs.hasLiveRunWsConnection(hostId)).toBe(true);
      ws.close();
    } finally {
      runWs.unregisterRunWsHost(hostId);
    }
  });

  test("rpc-ws requires host + wsToken", async () => {
    const noHost = await fetch(`http://${BASE}/rpc-ws`, {
      headers: { upgrade: "websocket", authorization: "Bearer whatever" },
    });
    expect(noHost.status).toBe(403);
    runWs.registerRunWsHost("rh-ingress-rpc", "rpc-sekrit");
    try {
      const ws = new WebSocket(
        `ws://${BASE}/rpc-ws?host=rh-ingress-rpc&token=rpc-sekrit`,
      );
      const opened = await new Promise<boolean>((resolve) => {
        ws.onopen = () => resolve(true);
        ws.onerror = () => resolve(false);
        setTimeout(() => resolve(false), 5000);
      });
      expect(opened).toBe(true);
      ws.close();
    } finally {
      runWs.unregisterRunWsHost("rh-ingress-rpc");
    }
  });
});

describe("rate limiting", () => {
  test("31st upgrade attempt in a window is 429; health is exempt", async () => {
    ingress.resetPublicIngressRateLimit();
    let last = 0;
    for (let i = 0; i < 30; i++) {
      const res = await fetch(`http://${BASE}/run-ws/rh-flood`, {
        headers: { upgrade: "websocket" },
      });
      last = res.status;
    }
    expect(last).toBe(403); // still auth-rejected, not rate-limited
    const over = await fetch(`http://${BASE}/run-ws/rh-flood`, {
      headers: { upgrade: "websocket" },
    });
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBe("60");
    const health = await fetch(`http://${BASE}/ingress-health`);
    expect(health.status).toBe(200);
    ingress.resetPublicIngressRateLimit();
  });

  test("buckets key on the proxy-appended (last) X-Forwarded-For hop", async () => {
    ingress.resetPublicIngressRateLimit();
    const hit = (xff: string) =>
      fetch(`http://${BASE}/run-ws/rh-xff`, {
        headers: { upgrade: "websocket", "x-forwarded-for": xff },
      });
    for (let i = 0; i < 31; i++) await hit("203.0.113.7");
    expect((await hit("203.0.113.7")).status).toBe(429);
    // A different client behind the same proxy is NOT limited…
    expect((await hit("203.0.113.8")).status).toBe(403);
    // …and a client-spoofed first hop can't dodge its own bucket: the LAST
    // hop (what the proxy appended) is the key.
    expect((await hit("8.8.8.8, 203.0.113.7")).status).toBe(429);
    ingress.resetPublicIngressRateLimit();
  });
});

describe("config gating", () => {
  test("disabled/absent publicIngress → startPublicIngress returns null", async () => {
    ingress.stopPublicIngress();
    try {
      writeConfig({ provider: "local" });
      expect(ingress.startPublicIngress({ port: 0 })).toBe(null);
      writeConfig({ provider: "local", publicIngress: { enabled: false } });
      expect(ingress.startPublicIngress({ port: 0 })).toBe(null);
    } finally {
      writeConfig({ provider: "local", publicIngress: { enabled: true } });
      handle = ingress.startPublicIngress({ port: 0, host: "127.0.0.1" });
      BASE = `127.0.0.1:${handle!.port}`;
    }
  });
});
