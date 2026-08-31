#!/usr/bin/env bun
/** Capture the running app with Mac/Retina-quality desktop defaults. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  acquireCdpBrowser,
  cdpSender,
  closeCdpTarget,
  releaseCdpBrowser,
} from "./lib/cdp-browser";
import { localAutomationToken } from "./lib/local-auth";
import { captureInitScript, captureViewport } from "./lib/visual-capture";

const argv = process.argv.slice(2);
const outputArg = argv.find((value) => !value.startsWith("--"));
const flag = (name: string, fallback?: string) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};
if (!outputArg) {
  console.error(
    "usage: bun scripts/capture-ui.ts <output.png> [--route /] [--width 1440] [--height 900] [--theme light|dark] [--user 'Local User'] [--web] [--wait 3000]",
  );
  process.exit(2);
}

const APP = process.env.OPENSESSION_URL ?? "http://127.0.0.1:3850";
const output = resolve(outputArg);
const route = flag("route", "/")!;
const width = Number(flag("width", "1440"));
const height = Number(flag("height", "900"));
const theme = flag("theme", "light");
const captureUser = flag("user");
// A session route loads its transcript after the app shell, so 3s catches it
// mid-"Checking sign-in". Give slow routes a longer settle rather than a
// screenshot of the loading state.
const settleMs = Number(flag("wait", "3000"));
if (!Number.isFinite(settleMs) || settleMs < 0)
  throw new Error("wait must be a non-negative number of milliseconds");
if (
  !Number.isInteger(width) ||
  !Number.isInteger(height) ||
  width < 1 ||
  height < 1
)
  throw new Error("width and height must be positive integers");
if (theme !== "light" && theme !== "dark")
  throw new Error("theme must be light or dark");
const viewport = captureViewport(width, height);
const electronMaterial = !viewport.mobile && !argv.includes("--web");

const FREEZE = `
  *, *::before, *::after {
    transition: none !important;
    animation: none !important;
    caret-color: transparent !important;
  }
  html { scroll-behavior: auto !important; }
`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const lease = await acquireCdpBrowser();
let target: { id?: string; webSocketDebuggerUrl?: string } | undefined;
let socket: WebSocket | undefined;

try {
  target = await fetch(
    `http://127.0.0.1:${lease.port}/json/new?url=about:blank`,
    {
      method: "PUT",
    },
  ).then((response) => response.json());
  const debuggerUrl = target?.webSocketDebuggerUrl;
  if (!debuggerUrl) throw new Error("CDP target has no debugger URL");
  socket = new WebSocket(debuggerUrl);
  await new Promise<void>((resolveOpen, reject) => {
    socket!.onopen = () => resolveOpen();
    socket!.onerror = () => reject(new Error("CDP connection failed"));
  });

  const send = cdpSender(socket);

  await send("Page.enable");
  await send("Network.enable");
  await send("Runtime.enable");
  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  const token = await localAutomationToken();
  if (token) {
    await send("Network.setCookie", {
      name: "opensession_auth",
      value: token,
      url: APP,
      path: "/",
    });
  }
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `${captureInitScript({ theme, electronMaterial, freezeCss: FREEZE })}\n${
      captureUser
        ? `try { localStorage.setItem('opensession-user', ${JSON.stringify(captureUser)}); } catch (e) {}`
        : ""
    }`,
  });
  await send("Emulation.setDeviceMetricsOverride", viewport);
  await send("Page.navigate", { url: new URL(route, APP).href });
  await sleep(settleMs);
  await send("Page.bringToFront");
  const probe = await send("Runtime.evaluate", {
    expression: `({
		  width: innerWidth,
		  height: innerHeight,
		  dpr: devicePixelRatio,
		  material: document.documentElement.classList.contains('material-backdrop'),
		  wco: document.documentElement.classList.contains('wco'),
		  platform: document.documentElement.dataset.platform
		})`,
    returnByValue: true,
  });
  const actual = probe?.result?.value;
  if (
    actual?.width !== width ||
    actual?.height !== height ||
    actual?.dpr !== viewport.deviceScaleFactor ||
    (electronMaterial &&
      (!actual?.material || !actual?.wco || actual?.platform !== "mac"))
  ) {
    throw new Error(
      `capture emulation did not apply: ${JSON.stringify(actual)}`,
    );
  }

  let previous = "";
  let screenshot = "";
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const result = await send("Page.captureScreenshot", { format: "png" });
    screenshot = result?.data ?? "";
    if (screenshot && screenshot === previous) break;
    previous = screenshot;
    await sleep(600);
  }
  if (!screenshot) throw new Error("Chrome returned no screenshot data");
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, Buffer.from(screenshot, "base64"));
  console.log(
    `${output}\nCSS viewport ${width}x${height}; PNG ${width * viewport.deviceScaleFactor}x${height * viewport.deviceScaleFactor}; DPR ${viewport.deviceScaleFactor}; ${electronMaterial ? "Electron material" : "web"}`,
  );
} finally {
  socket?.close();
  await closeCdpTarget(lease.port, target?.id);
  await releaseCdpBrowser(lease);
}
