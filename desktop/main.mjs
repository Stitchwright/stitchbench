// StitchBench for the shop PC.
// Starts its own PostgreSQL, updates the database, runs the StitchBench server for every device on the shop
// network (Wi-Fi or Tailscale), opens it in a window, and keeps nightly backups. Closing the window leaves it
// running in the tray so other devices can keep working; Quit from the tray stops everything.
import { app, BrowserWindow, Tray, Menu, shell, clipboard, dialog, nativeImage, Notification } from "electron";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { migrate } from "./migrate.mjs";
import { backup, restore, listBackups } from "./backup.mjs";

const HERE = import.meta.dirname;
const APP_DIR = app.isPackaged ? path.join(process.resourcesPath, "server") : path.join(HERE, "server");
const DATA = app.getPath("userData"); // %APPDATA%\StitchBench
const CONFIG_FILE = path.join(DATA, "config.json");
const LOG_FILE = path.join(DATA, "logs", "stitchbench.log");
const ICON = path.join(HERE, "icon.png");

let cfg, db, pool, server, win, tray;
let quitting = false;
let signupOpen = false;
const recent = [];

// ---------- log & config ----------

function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.map((p) => (p instanceof Error ? p.stack : String(p))).join(" ")}`.trimEnd();
  recent.push(line);
  if (recent.length > 300) recent.shift();
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 5_000_000) fs.renameSync(LOG_FILE, LOG_FILE + ".old");
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {
    /* logging must never stop the program */
  }
}

function loadConfig() {
  const defaults = {
    port: 3100,
    dbPort: 5439,
    libraryDir: "C:\\Manuals",
    backupDir: path.join(app.getPath("documents"), "StitchBench Backups"),
    backupsToKeep: 30,
    platformAdminEmails: "",
    openAtLogin: true,
  };
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    /* first run */
  }
  const c = { ...defaults, ...saved };
  c.dbPassword ||= crypto.randomBytes(18).toString("base64url");
  c.authSecret ||= crypto.randomBytes(33).toString("base64");
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2));
  return c;
}

// ---------- database ----------

async function startDatabase() {
  const dir = path.join(DATA, "db");
  db = new EmbeddedPostgres({
    databaseDir: dir,
    port: cfg.dbPort,
    user: "stitchbench",
    password: cfg.dbPassword,
    authMethod: "scram-sha-256",
    // UTF-8 whatever Windows' language is (otherwise initdb picks WIN1252 and manual text with e.g. Japanese fails).
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    persistent: true,
    onLog: () => {},
    onError: (e) => log("postgres:", e),
  });
  if (!fs.existsSync(path.join(dir, "PG_VERSION"))) {
    log("creating the database");
    await db.initialise();
  }
  try {
    await db.start();
  } catch (e) {
    // Still running from last time (e.g. after a crash)? Use it if the password works.
    log("postgres start failed, trying the running one:", e);
  }
  const admin = new pg.Client({ host: "127.0.0.1", port: cfg.dbPort, user: "stitchbench", password: cfg.dbPassword, database: "postgres" });
  await admin.connect();
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'stitchbench'");
  if (!exists.rowCount) await admin.query("CREATE DATABASE stitchbench ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0");
  await admin.end();
  pool = new pg.Pool({ host: "127.0.0.1", port: cfg.dbPort, user: "stitchbench", password: cfg.dbPassword, database: "stitchbench", max: 4 });
  const n = await migrate(pool, path.join(APP_DIR, "migrations"), log);
  log(`database ready (${n} update${n === 1 ? "" : "s"} applied)`);
}

const databaseUrl = () => `postgresql://stitchbench:${encodeURIComponent(cfg.dbPassword)}@127.0.0.1:${cfg.dbPort}/stitchbench`;

// ---------- the StitchBench server ----------

function get(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", () => resolve(0));
    req.setTimeout(3000, () => req.destroy());
  });
}

/** The installer carries the server's node_modules folders as _node_modules (see prepare-app.mjs); put the names back. */
function unpackModules(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    let p = path.join(dir, e.name);
    if (e.name === "_node_modules") {
      const real = path.join(dir, "node_modules");
      fs.rmSync(real, { recursive: true, force: true });
      fs.renameSync(p, real);
      p = real;
    }
    unpackModules(p);
  }
}

async function startServer() {
  // Only after a fresh install or update.
  if (fs.existsSync(path.join(APP_DIR, "_node_modules"))) {
    log("unpacking the server's modules");
    unpackModules(APP_DIR);
  }
  const shops = Number((await pool.query(`SELECT count(*) AS n FROM "Shop"`)).rows[0].n);
  // A brand-new install lets the first person create the company and owner login, then closes sign-up.
  signupOpen = shops === 0;
  server = spawn(process.execPath, [path.join(APP_DIR, "server.js")], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: "production",
      PORT: String(cfg.port),
      HOSTNAME: process.env.SB_LISTEN ?? "0.0.0.0", // SB_LISTEN=127.0.0.1 for a this-PC-only test run
      DATABASE_URL: databaseUrl(),
      AUTH_SECRET: cfg.authSecret,
      AUTH_TRUST_HOST: "true",
      LIBRARY_DIR: cfg.libraryDir,
      PLATFORM_ADMIN_EMAILS: cfg.platformAdminEmails,
      ALLOW_SIGNUP: signupOpen ? "true" : "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  server.stdout.on("data", (d) => log("server:", d.toString().trim()));
  server.stderr.on("data", (d) => log("server error:", d.toString().trim()));
  server.on("exit", (code) => {
    log("server stopped", code);
    server = null;
  });
  for (let i = 0; i < 120; i++) {
    if ((await get(`http://127.0.0.1:${cfg.port}/login`)) === 200) return;
    if (!server) throw new Error("The StitchBench server stopped while starting. See the log.");
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("The StitchBench server didn't start within a minute. See the log.");
}

async function stopServer() {
  if (!server) return;
  const s = server;
  await new Promise((resolve) => {
    s.once("exit", resolve);
    s.kill();
    setTimeout(resolve, 5000);
  });
  server = null;
}

async function restartServer() {
  await stopServer();
  await startServer();
  win?.reload();
}

// Close sign-up as soon as the first company exists.
setInterval(async () => {
  if (!signupOpen || !pool || quitting) return;
  const shops = Number((await pool.query(`SELECT count(*) AS n FROM "Shop"`).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n);
  if (shops > 0) {
    log("first company created; closing sign-up");
    await restartServer().catch((e) => log(e));
  }
}, 15_000);

// ---------- addresses for other devices ----------

function addresses() {
  const out = [{ label: `This PC's name`, url: `http://${os.hostname().toLowerCase()}:${cfg.port}` }];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const [p1, p2] = a.address.split(".").map(Number);
      const tailscale = p1 === 100 && p2 >= 64 && p2 <= 127;
      out.push({ label: tailscale ? "Tailscale (on the road)" : `Wi-Fi / network (${name})`, url: `http://${a.address}:${cfg.port}` });
    }
  }
  return out;
}

// ---------- backups ----------

async function runBackup(reason) {
  try {
    const dir = await backup(pool, cfg.backupDir, cfg.backupsToKeep);
    log(`backup (${reason}) saved to ${dir}`);
    return dir;
  } catch (e) {
    log("backup failed:", e);
    new Notification({ title: "StitchBench backup failed", body: String(e instanceof Error ? e.message : e) }).show();
    return null;
  }
}

function lastBackupTime() {
  const [latest] = listBackups(cfg.backupDir);
  return latest ? fs.statSync(latest).mtimeMs : 0;
}

setInterval(() => {
  if (!pool || quitting) return;
  // Once a day, after 1 am, or whenever the last one is more than a day old.
  const d = new Date();
  const today1am = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 1).getTime();
  const last = lastBackupTime();
  if ((d.getTime() >= today1am && last < today1am) || Date.now() - last > 26 * 3600_000) runBackup("nightly");
}, 20 * 60_000);

async function restoreFromBackup() {
  const pick = await dialog.showOpenDialog({ title: "Choose a StitchBench backup folder", defaultPath: cfg.backupDir, properties: ["openDirectory"] });
  if (pick.canceled || !pick.filePaths[0]) return;
  const dir = pick.filePaths[0];
  if (!fs.existsSync(path.join(dir, "manifest.json"))) {
    dialog.showErrorBox("Not a backup", "Pick a folder named like stitchbench-2026-09-25-01-00 from the backups folder.");
    return;
  }
  const { created } = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const ok = await dialog.showMessageBox({
    type: "warning",
    buttons: ["Restore", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    title: "Restore a backup",
    message: `Replace all shop data with the backup from ${new Date(created).toLocaleString()}?`,
    detail: "Customers, machines, tickets, photos, parts and people go back to that point. The current data is backed up first.",
  });
  if (ok.response !== 0) return;
  await runBackup("before restore");
  await stopServer();
  try {
    await restore(pool, dir);
    log(`restored ${dir}`);
    dialog.showMessageBox({ message: "Backup restored." });
  } catch (e) {
    log("restore failed:", e);
    dialog.showErrorBox("Restore failed", String(e instanceof Error ? e.message : e));
  }
  await startServer().catch((e) => dialog.showErrorBox("StitchBench", String(e)));
  win?.reload();
}

// ---------- window & tray ----------

function base() {
  return `http://localhost:${cfg.port}`;
}

function showWindow() {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 1400,
    height: 950,
    show: false,
    icon: ICON,
    title: "StitchBench",
    autoHideMenuBar: true,
    webPreferences: { plugins: true }, // built-in PDF viewer for manuals
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(base()) || url.startsWith("blob:") || url === "about:blank") {
      return { action: "allow", overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: ICON, webPreferences: { plugins: true } } };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.once("ready-to-show", () => win.show());
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!cfg.toldAboutTray) {
      cfg.toldAboutTray = true;
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
      tray?.displayBalloon({ title: "StitchBench is still running", content: "Other devices can keep using it. Quit from this icon." });
    }
  });
  win.on("closed", () => (win = null));
  win.loadURL(signupOpen ? `${base()}/signup` : base());
}

function buildTray() {
  tray ??= new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip("StitchBench");
  tray.on("double-click", showWindow);
  const addr = addresses();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open StitchBench", click: showWindow },
      {
        label: "Address for other devices (click to copy)",
        submenu: addr.map((a) => ({ label: `${a.label}: ${a.url}`, click: () => clipboard.writeText(a.url) })),
      },
      { type: "separator" },
      { label: "Back up now", click: async () => (await runBackup("manual")) && new Notification({ title: "StitchBench", body: "Backup saved." }).show() },
      { label: "Open backups folder", click: () => (fs.mkdirSync(cfg.backupDir, { recursive: true }), shell.openPath(cfg.backupDir)) },
      { label: "Restore a backup...", click: () => restoreFromBackup().catch((e) => dialog.showErrorBox("StitchBench", String(e))) },
      { type: "separator" },
      {
        label: "Start with Windows",
        type: "checkbox",
        checked: cfg.openAtLogin,
        click: (item) => {
          cfg.openAtLogin = item.checked;
          fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
          applyLoginItem();
        },
      },
      { label: "Settings file (restart to apply)", click: () => shell.openPath(CONFIG_FILE) },
      { label: "Show log", click: () => shell.openPath(LOG_FILE) },
      { label: "Restart StitchBench", click: () => (app.relaunch(), quit()) },
      { type: "separator" },
      { label: "Quit StitchBench", click: quit },
    ]),
  );
}

function applyLoginItem() {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: cfg.openAtLogin, args: ["--hidden"] });
}

async function quit() {
  if (quitting) return;
  quitting = true;
  log("quitting");
  await stopServer();
  await pool?.end().catch(() => {});
  await db?.stop().catch((e) => log("postgres stop:", e));
  app.exit(0);
}

// ---------- start ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  app.on("window-all-closed", () => {}); // keep serving from the tray
  app.whenReady().then(async () => {
    cfg = loadConfig();
    log(`starting StitchBench ${app.getVersion()}`);
    buildTray();
    applyLoginItem();
    try {
      await startDatabase();
      await startServer();
    } catch (e) {
      log("startup failed:", e);
      dialog.showErrorBox("StitchBench couldn't start", `${e instanceof Error ? e.message : e}\n\nLog: ${LOG_FILE}`);
      return quit();
    }
    buildTray(); // addresses can change while starting (Tailscale comes up late)
    setInterval(buildTray, 5 * 60_000);
    if (!process.argv.includes("--hidden")) showWindow();
    if (Date.now() - lastBackupTime() > 26 * 3600_000) setTimeout(() => runBackup("startup"), 60_000);
  });
}
