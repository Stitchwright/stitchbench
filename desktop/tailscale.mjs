// Tailscale on the shop PC, for the secure address (HANDOFF item 11). Browsers hand the camera and the clipboard only
// to a secure page, so a tablet on plain http://<pc>:3100 can't use the barcode camera or the copy buttons. With
// Tailscale on the PC and the tablets, `tailscale serve --bg --https=443 http://127.0.0.1:<port>` gives the program an
// https://<device>.<tailnet>.ts.net address on every device of the tailnet (Tailscale's own certificate, nothing to
// install on the tablets). This file finds the CLI, reads its status and runs serve; main.mjs owns the tray flow and the
// settings. Plain functions, nothing from Electron, so the parsers can be unit-tested (test/tailscale.test.mjs).
// Checked against Tailscale's docs (kb/1242/tailscale-serve) and the CLI source (cmd/tailscale/cli/serve_v2.go) on
// 2 Oct 2026: serve preserves the browser's Host header and adds X-Forwarded-Proto: https, so the server sees the
// ts.net host (Auth.js and server actions are happy) and nothing of TRUST_PROXY is needed.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

export const SERVE_PORT = 443;

/** Run the CLI; resolves { code, stdout, stderr } (never rejects on a non-zero exit, only on a missing program). */
function run(exe, args, { timeout = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error && (error.code === "ENOENT" || error.killed)) return reject(error.killed ? new Error(`"tailscale ${args.join(" ")}" didn't answer within ${timeout / 1000} s`) : error);
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

/** The tailscale CLI on this PC: its path, or null. The installer's folder first, then the Store app's alias, then PATH. */
export async function findTailscale(env = process.env) {
  const candidates = [
    path.join(env.ProgramFiles ?? "C:\\Program Files", "Tailscale", "tailscale.exe"),
    path.join(env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Tailscale", "tailscale.exe"),
    ...(env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, "Microsoft", "WindowsApps", "tailscale.exe")] : []),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  if (process.platform !== "win32") return null;
  try {
    const r = await run("where.exe", ["tailscale"], { timeout: 5000 });
    const first = r.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean);
    return r.code === 0 && first ? first : null;
  } catch {
    return null;
  }
}

/** The device's DNS name from `tailscale status --json`: "shop-pc.tail1234.ts.net" (the trailing dot removed), or "". */
export function dnsNameOf(status) {
  const raw = status?.Self?.DNSName;
  return typeof raw === "string" ? raw.replace(/\.$/, "").toLowerCase() : "";
}

/**
 * What the tray needs to know, from `tailscale status --json`:
 * { running, dnsName, httpsEnabled, state }. httpsEnabled is Tailscale's "HTTPS certificates" switch (admin console,
 * DNS page): without it, serve can't get a certificate. CertDomains holds the names the control plane will certify.
 */
export function summarizeStatus(status) {
  const state = typeof status?.BackendState === "string" ? status.BackendState : "NoState";
  const dnsName = dnsNameOf(status);
  const certDomains = Array.isArray(status?.CertDomains) ? status.CertDomains.map((d) => String(d).toLowerCase().replace(/\.$/, "")) : [];
  return { running: state === "Running", state, dnsName, httpsEnabled: !!dnsName && certDomains.includes(dnsName) };
}

export async function tailscaleStatus(exe) {
  const r = await run(exe, ["status", "--json"]);
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    /* "Logged out." and the like aren't JSON */
  }
  return summarizeStatus(parsed);
}

/**
 * Read a serve config (`tailscale serve status --json`) for our port: { on, target, funnel }. `on` when the handler for
 * "/" on :443 proxies to the given local port; `funnel` when Funnel is allowed on :443 (then turning serve on for the
 * whole program would put it on the public internet: refused by the tray). The config may be absent ("No serve config").
 */
export function readServeConfig(json, port) {
  const out = { on: false, target: "", funnel: false };
  let cfg;
  try {
    cfg = typeof json === "string" ? JSON.parse(json) : json;
  } catch {
    return out;
  }
  if (!cfg || typeof cfg !== "object") return out;
  for (const [hostPort, allowed] of Object.entries(cfg.AllowFunnel ?? {})) if (allowed && hostPort.endsWith(`:${SERVE_PORT}`)) out.funnel = true;
  for (const [hostPort, web] of Object.entries(cfg.Web ?? {})) {
    if (!hostPort.endsWith(`:${SERVE_PORT}`)) continue;
    const proxy = web?.Handlers?.["/"]?.Proxy;
    if (typeof proxy !== "string") continue;
    out.target = proxy;
    try {
      const u = new URL(proxy);
      if (u.protocol === "http:" && Number(u.port || 80) === Number(port) && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname === "::1" ? "[::1]" : u.hostname)) out.on = true;
    } catch {
      /* not a URL we know */
    }
  }
  return out;
}

export async function serveStatus(exe, port) {
  const r = await run(exe, ["serve", "status", "--json"]);
  return readServeConfig(r.stdout, port);
}

/** The first https link in a CLI message (Tailscale prints one when an admin has to approve something). */
export function linkIn(text) {
  const m = /https:\/\/[^\s"'<>]+/.exec(text ?? "");
  return m ? m[0].replace(/[.,)]+$/, "") : null;
}

/** Serve the program's local port on https://<device>.<tailnet>.ts.net (port 443), in the background and across restarts. */
export async function serveOn(exe, port) {
  const r = await run(exe, ["serve", "--bg", `--https=${SERVE_PORT}`, `http://127.0.0.1:${port}`], { timeout: 60_000 });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `tailscale serve exited with ${r.code}`);
  return r.stdout;
}

/** Remove the "/" handler on port 443 (the target is optional with `off`, serve_v2.go). Other ports are left alone. */
export async function serveOff(exe) {
  const r = await run(exe, ["serve", `--https=${SERVE_PORT}`, "off"], { timeout: 30_000 });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `tailscale serve off exited with ${r.code}`);
  return r.stdout;
}
