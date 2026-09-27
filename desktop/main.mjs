// StitchBench (or StitchShop) for the shop PC.
// Starts its own PostgreSQL, updates the database, runs the server for every device on the shop network (Wi-Fi or
// Tailscale), opens it in a window, and keeps nightly backups. Closing the window leaves it running in the tray so
// other devices can keep working; Quit from the tray stops everything.
// One program, two names: StitchBench for a repair bench, StitchShop for a sewing / quilt shop counter. The
// StitchShop build sets "flavor": "stitchshop" in package.json (npm run dist:stitchshop); SB_FLAVOR overrides it for a
// test run. The two keep separate data, ports and backups, so both can be on one PC.
import { app, BrowserWindow, Tray, Menu, shell, clipboard, dialog, nativeImage, Notification, session } from "electron";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { migrate } from "./migrate.mjs";
import { backup, restore, listBackups, readManifest } from "./backup.mjs";
import { loadReference } from "./reference.mjs";

const HERE = import.meta.dirname;
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, "package.json"), "utf8"));
const FLAVOR = (process.env.SB_FLAVOR ?? PKG.flavor) === "stitchshop" ? "stitchshop" : "stitchbench";
const NAME = FLAVOR === "stitchshop" ? "StitchShop" : "StitchBench";
app.setName(NAME); // before anything asks for userData
// The installer's shortcut carries this id; Windows shows the program's notifications only when they match.
app.setAppUserModelId(`com.timingandtension.${FLAVOR}`);
const APP_DIR = app.isPackaged ? path.join(process.resourcesPath, "server") : path.join(HERE, "server");
const DATA = app.getPath("userData"); // %APPDATA%\StitchBench or %APPDATA%\StitchShop
const CONFIG_FILE = path.join(DATA, "config.json");
// The database password and sign-in secret: kept out of the settings file people edit, so a typo there can't lose them.
const SECRETS_FILE = path.join(DATA, "secrets.json");
const LOG_FILE = path.join(DATA, "logs", `${FLAVOR}.log`);
const ICON = path.join(HERE, "icon.png");

let cfg, db, pool, server, win, tray;
let quitting = false;
let signupOpen = false;
let setupToken = "";
let stopping = false; // stopServer asked the server to exit
let starting = false; // startServer is waiting for it to answer
let dbOwned = false; // the postgres this program started is running (not one it only connected to, nor one that died)
let maintenance = false; // a restore is replacing the data
let backingUp = false;
let status = null; // shown in the tray when the server isn't running normally
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

class SettingsError extends Error {
  constructor(file, cause) {
    super(`${file}\n\n${cause instanceof Error ? cause.message : cause}`);
    this.file = file;
  }
}

/** A JSON settings file: undefined when there isn't one; throws SettingsError when it can't be read or isn't valid. */
function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return undefined;
    throw new SettingsError(file, e);
  }
  let v;
  try {
    v = JSON.parse(text.replace(/^\uFEFF/, "")); // Notepad and PowerShell may put a byte-order mark first
  } catch (e) {
    throw new SettingsError(file, e);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new SettingsError(file, "It should be a list of settings in { }.");
  return v;
}

/** Either the old file or the new one, never half of each (a power cut mid-save). */
function writeAtomic(file, text) {
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
}

/** Save the settings, keeping the last good copy as config.json.bak. */
function writeConfig(c) {
  const { dbPassword, authSecret, ...plain } = c;
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      readJson(CONFIG_FILE); // only a good file becomes the backup copy
      fs.copyFileSync(CONFIG_FILE, `${CONFIG_FILE}.bak`);
    }
  } catch {
    /* the current file is broken: keep the older .bak */
  }
  writeAtomic(CONFIG_FILE, JSON.stringify(plain, null, 2));
}

/** Change one setting, re-reading the file first so edits made while the program runs aren't written over. */
function saveSetting(key, value) {
  cfg[key] = value;
  try {
    const onDisk = readJson(CONFIG_FILE) ?? {};
    writeConfig({ ...onDisk, [key]: value });
  } catch (e) {
    log(`couldn't save ${key}:`, e);
  }
}

function loadConfig() {
  const shop = FLAVOR === "stitchshop";
  const defaults = {
    port: shop ? 3110 : 3100,
    dbPort: shop ? 5449 : 5439,
    // A sewing shop keeps no manual library (its repair shop does).
    libraryDir: shop ? "" : "C:\\Manuals",
    backupDir: path.join(app.getPath("documents"), `${NAME} Backups`),
    backupsToKeep: 30,
    platformAdminEmails: "",
    openAtLogin: true,
  };
  fs.mkdirSync(DATA, { recursive: true });
  const saved = readJson(CONFIG_FILE);
  const secrets = readJson(SECRETS_FILE) ?? {};
  // Older versions kept the secrets in config.json: they move to secrets.json the first time.
  let dbPassword = secrets.dbPassword ?? saved?.dbPassword;
  const authSecret = secrets.authSecret ?? saved?.authSecret ?? crypto.randomBytes(33).toString("base64");
  if (!dbPassword) {
    // A database made with a password we no longer have can't be opened with a new one: never make one up for it.
    if (fs.existsSync(path.join(DATA, "db", "PG_VERSION"))) {
      throw new Error(
        `The database password is missing from ${SECRETS_FILE}.\n\nIf you have a copy of that file (or of an older config.json that has "dbPassword"), put it back and start ${NAME} again.`,
      );
    }
    dbPassword = crypto.randomBytes(18).toString("base64url");
  }
  if (secrets.dbPassword !== dbPassword || secrets.authSecret !== authSecret) {
    writeAtomic(SECRETS_FILE, JSON.stringify({ dbPassword, authSecret }, null, 2));
  }
  const c = { ...defaults, ...(saved ?? {}) };
  delete c.dbPassword;
  delete c.authSecret;
  // First run: write the defaults so the settings file shows what can be changed. Also drops moved secrets.
  if (!saved || "dbPassword" in saved || "authSecret" in saved) writeConfig(c);
  return { ...c, dbPassword, authSecret };
}

/** A settings file that can't be read: say which and why, and offer the last good copy. Returns true to try again. */
async function settingsProblem(e) {
  const bak = `${e.file}.bak`;
  let bakOk = false;
  try {
    bakOk = fs.existsSync(bak) && !!readJson(bak);
  } catch {
    /* no good backup copy */
  }
  const buttons = ["Open the settings file", ...(bakOk ? ["Start with the last settings that worked"] : []), "Quit"];
  const r = await dialog.showMessageBox({
    type: "error",
    title: `${NAME} settings`,
    message: `${NAME} can't read its settings file, so it hasn't started. Nothing has been changed.`,
    detail: `${e.message}\n\nA common cause is a Windows path with single backslashes: write C:\\\\Manuals, not C:\\Manuals.`,
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
  });
  if (buttons[r.response] === "Open the settings file") shell.openPath(e.file);
  if (buttons[r.response] === "Start with the last settings that worked") {
    fs.copyFileSync(e.file, `${e.file}.broken`);
    fs.copyFileSync(bak, e.file);
    log(`settings: ${e.file} was broken (kept as .broken); started from .bak`);
    return true;
  }
  return false;
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
    dbOwned = true;
    // Once it has gone, forget it: db.stop() waits forever for a process that has already exited, and would taskkill a
    // PID that Windows may have handed to something else since.
    db.process?.once("exit", (code) => {
      dbOwned = false;
      db.process = undefined;
      log("postgres stopped", code);
    });
  } catch (e) {
    // Still running from last time (e.g. after a crash), or the port is taken? Use the one there if the password works.
    db.process = undefined; // start fails when the process it spawned exits: same as above
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

let startedAt = 0;
let failures = 0;
let restartTimer = null;

async function startServer() {
  // Only after a fresh install or update.
  if (fs.existsSync(path.join(APP_DIR, "_node_modules"))) {
    log("unpacking the server's modules");
    unpackModules(APP_DIR);
  }
  const shops = Number((await pool.query(`SELECT count(*) AS n FROM "Shop"`)).rows[0].n);
  // A brand-new install lets the first person create the company and owner login, then closes sign-up. Only this
  // program's own window can: it opens /signup with a token nobody on the network has.
  signupOpen = shops === 0;
  setupToken = signupOpen ? crypto.randomBytes(24).toString("base64url") : "";
  const child = spawn(process.execPath, [path.join(APP_DIR, "server.js")], {
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
      // Browsers share cookies across ports: a device that opens both programs on one PC would otherwise sign out of
      // the other each time. Each program names its sign-in cookies after itself.
      AUTH_COOKIE_PREFIX: FLAVOR,
      LIBRARY_DIR: cfg.libraryDir,
      PLATFORM_ADMIN_EMAILS: cfg.platformAdminEmails,
      ALLOW_SIGNUP: signupOpen ? "true" : "false",
      SETUP_TOKEN: setupToken,
      APP_NAME: NAME,
      DEFAULT_SHOP_KIND: FLAVOR === "stitchshop" ? "retail" : "repair",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  server = child;
  child.stdout.on("data", (d) => log("server:", d.toString().trim()));
  child.stderr.on("data", (d) => log("server error:", d.toString().trim()));
  child.on("exit", (code) => {
    log("server stopped", code);
    if (server !== child) return;
    server = null;
    // Asked to stop, or still starting (startServer reports that itself): nothing more to do here.
    if (quitting || stopping || starting) return;
    if (Date.now() - startedAt > 10 * 60_000) failures = 0;
    serverDown(`stopped (${code})`);
  });
  starting = true;
  try {
    for (let i = 0; i < 120; i++) {
      if ((await get(`http://127.0.0.1:${cfg.port}/login`)) === 200) {
        startedAt = Date.now();
        setStatus(null);
        return;
      }
      if (server !== child) throw new Error(`The ${NAME} server stopped while starting. See the log.`);
      await new Promise((r) => setTimeout(r, 500));
    }
  } finally {
    starting = false;
  }
  await stopServer(); // it never answered: don't leave it holding the port
  throw new Error(`The ${NAME} server didn't start within a minute. See the log.`);
}

async function stopServer() {
  clearTimeout(restartTimer);
  if (!server) return;
  const s = server;
  stopping = true;
  try {
    await new Promise((resolve) => {
      s.once("exit", resolve);
      s.kill();
      setTimeout(resolve, 5000);
    });
  } finally {
    stopping = false;
  }
  if (server === s) server = null;
}

/** The server stopped on its own (or wouldn't start again): say so in the tray and keep trying, waiting longer each time. */
function serverDown(why) {
  if (quitting || maintenance) return;
  const wait = [2, 10, 30, 60, 300][Math.min(failures, 4)];
  if (failures === 0) notify(`${NAME} stopped`, "Starting it again. Other devices reconnect when it's back.");
  failures++;
  setStatus(`${why}; trying again in ${wait} s`);
  clearTimeout(restartTimer);
  restartTimer = setTimeout(async () => {
    if (quitting || server || maintenance) return;
    try {
      await startServer();
      log("server running again");
      reloadWindow();
    } catch (e) {
      log("server restart failed:", e);
      serverDown("won't start");
    }
  }, wait * 1000);
}

/** The window's page again once the server is back. The first-run sign-up page can't be: the new server has a new token. */
function reloadWindow() {
  if (!win) return;
  if (win.webContents.getURL().startsWith(`${base()}/signup`)) win.loadURL(home());
  else win.reload();
}

// Once the first company exists, the window goes to the normal pages. The server needs no restart to close sign-up: it
// refuses a second company itself (createShopWithOwner's lock), and ALLOW_SIGNUP is dropped at the next start. A restart
// here would cut off the sign-up still finishing (its partner code spent on the hub, the install key never saved).
setInterval(async () => {
  if (!signupOpen || !pool || quitting || maintenance || starting || stopping) return;
  const shops = Number((await pool.query(`SELECT count(*) AS n FROM "Shop"`).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n);
  if (shops > 0) {
    log("first company created; sign-up is closed");
    signupOpen = false;
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

function notify(title, body) {
  try {
    new Notification({ title, body, icon: ICON }).show();
  } catch (e) {
    log("notification:", e);
  }
}

async function runBackup(reason, { prune = true } = {}) {
  backingUp = true;
  buildTray();
  try {
    const dir = await backup(pool, cfg.backupDir, { keep: cfg.backupsToKeep, flavor: FLAVOR, prune, version: app.getVersion() });
    log(`backup (${reason}) saved to ${dir}`);
    return dir;
  } catch (e) {
    log("backup failed:", e);
    notify(`${NAME} backup failed`, String(e instanceof Error ? e.message : e));
    return null;
  } finally {
    backingUp = false;
    buildTray();
  }
}

function lastBackupTime() {
  const [latest] = listBackups(cfg.backupDir, FLAVOR);
  return latest ? fs.statSync(latest).mtimeMs : 0;
}

setInterval(() => {
  if (!pool || quitting || maintenance) return;
  // Once a day, after 1 am, or whenever the last one is more than a day old.
  const d = new Date();
  const today1am = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 1).getTime();
  const last = lastBackupTime();
  if ((d.getTime() >= today1am && last < today1am) || Date.now() - last > 26 * 3600_000) runBackup("nightly");
}, 20 * 60_000);

async function restoreFromBackup() {
  const pick = await dialog.showOpenDialog({ title: `Choose a ${NAME} backup folder`, defaultPath: cfg.backupDir, properties: ["openDirectory"] });
  if (pick.canceled || !pick.filePaths[0]) return;
  const dir = pick.filePaths[0];
  const { manifest, error } = readManifest(dir, FLAVOR);
  if (error) {
    dialog.showErrorBox("Can't restore that folder", error);
    return;
  }
  const ok = await dialog.showMessageBox({
    type: "warning",
    buttons: ["Restore", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    title: "Restore a backup",
    message: `Replace all shop data with the backup from ${new Date(manifest.created).toLocaleString()}?`,
    detail: `Customers, machines, tickets, photos, parts and people go back to that point. ${NAME} stops for a minute while the current data is backed up first; if that backup can't be made, nothing is restored.`,
  });
  if (ok.response !== 0) return;
  maintenance = true;
  try {
    // Stopped first, so nothing rung up on another device during the safety copy is lost.
    await stopServer();
    setStatus("restoring a backup");
    const saved = await runBackup("before restore", { prune: false });
    if (!saved) {
      dialog.showErrorBox(
        "Restore stopped",
        `The current data couldn't be backed up first, so nothing was restored and nothing changed.\n\nCheck that the backups folder is reachable and has room:\n${cfg.backupDir}\n\nLog: ${LOG_FILE}`,
      );
    } else {
      try {
        await restore(pool, dir, FLAVOR);
        log(`restored ${dir}`);
        dialog.showMessageBox({ message: "Backup restored.", detail: `The data from just before is saved in:\n${saved}` });
      } catch (e) {
        log("restore failed:", e);
        dialog.showErrorBox("Restore failed", `${e instanceof Error ? e.message : e}\n\nNothing was changed.`);
      }
    }
  } finally {
    maintenance = false;
  }
  try {
    await startServer();
  } catch (e) {
    log("server start after restore failed:", e);
    serverDown("won't start");
  }
  win?.loadURL(home());
}

// ---------- window & tray ----------

function base() {
  return `http://localhost:${cfg.port}`;
}

function home() {
  return signupOpen ? `${base()}/signup?setup=${setupToken}` : base();
}

/** The program's own pages: this server's address exactly (no user@ tricks, no other port or host). */
function isApp(url) {
  try {
    const u = new URL(url.startsWith("blob:") ? url.slice(5) : url);
    // Both sides as URL origins: with "port": 80 the origin is plain http://localhost, without the port.
    const own = [base(), `http://127.0.0.1:${cfg.port}`].map((a) => new URL(a).origin);
    return own.includes(u.origin) && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** Anything else opens in the web browser (or mail / phone app); other kinds of link are ignored. */
function openOutside(url) {
  try {
    const u = new URL(url);
    if (["http:", "https:", "mailto:", "tel:"].includes(u.protocol)) shell.openExternal(u.href);
    else log("link not opened:", u.protocol);
  } catch {
    /* not a link */
  }
}

// What a web page may ask for only when it is one of the program's own (the barcode camera, copy buttons).
const SENSITIVE = new Set([
  "media", "geolocation", "notifications", "midi", "midiSysex", "hid", "serial", "usb", "clipboard-read", "display-capture",
  "openExternal", "pointerLock", "keyboardLock", "idle-detection", "window-management", "fileSystem", "speaker-selection",
]);

function guardSessions() {
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(!SENSITIVE.has(permission) || isApp(details?.requestingUrl || wc?.getURL() || ""));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin) => !SENSITIVE.has(permission) || isApp(origin || wc?.getURL() || ""));
  // Every window and page the program shows, including manual windows opened from it: other sites go to the browser.
  app.on("web-contents-created", (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (isApp(url) || url === "about:blank") {
        return { action: "allow", overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: ICON, webPreferences: { plugins: true } } };
      }
      openOutside(url);
      return { action: "deny" };
    });
    if (contents.getType() === "window") {
      contents.on("will-navigate", (e, url) => {
        if (isApp(url)) return;
        e.preventDefault();
        openOutside(url);
      });
    }
  });
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
    title: NAME,
    autoHideMenuBar: true,
    webPreferences: { plugins: true }, // built-in PDF viewer for manuals
  });
  win.once("ready-to-show", () => win.show());
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!cfg.toldAboutTray) {
      saveSetting("toldAboutTray", true);
      tray?.displayBalloon({ title: `${NAME} is still running`, content: "Other devices can keep using it. Quit from this icon." });
    }
  });
  win.on("closed", () => (win = null));
  win.loadURL(home());
}

function setStatus(text) {
  if (status === text) return;
  status = text;
  if (text) log("status:", text);
  buildTray();
}

function buildTray() {
  if (!cfg) return;
  tray ??= new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip(status ? `${NAME}: ${status}` : NAME);
  if (!tray.listenerCount("double-click")) tray.on("double-click", showWindow);
  const addr = addresses();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      ...(status ? [{ label: `Server: ${status}`, enabled: false }, { label: "Show log", click: () => shell.openPath(LOG_FILE) }, { type: "separator" }] : []),
      { label: `Open ${NAME}`, click: showWindow },
      {
        label: "Address for other devices (click to copy)",
        submenu: addr.map((a) => ({ label: `${a.label}: ${a.url}`, click: () => clipboard.writeText(a.url) })),
      },
      { type: "separator" },
      {
        label: backingUp ? "Backing up..." : "Back up now",
        enabled: !backingUp && !maintenance && !!pool, // a restore takes its own safety copy first
        click: async () => (await runBackup("manual")) && notify(NAME, "Backup saved."),
      },
      { label: "Open backups folder", click: () => (fs.mkdirSync(cfg.backupDir, { recursive: true }), shell.openPath(cfg.backupDir)) },
      {
        label: "Restore a backup...",
        enabled: !maintenance && !!pool,
        click: () => restoreFromBackup().catch((e) => dialog.showErrorBox(NAME, String(e))),
      },
      { type: "separator" },
      {
        label: "Start with Windows",
        type: "checkbox",
        checked: cfg.openAtLogin,
        click: (item) => {
          saveSetting("openAtLogin", item.checked);
          applyLoginItem();
        },
      },
      { label: "Settings file (restart to apply)", click: () => shell.openPath(CONFIG_FILE) },
      { label: "Show log", click: () => shell.openPath(LOG_FILE) },
      { label: `Restart ${NAME}`, click: () => (app.relaunch(), quit()) },
      { type: "separator" },
      { label: `Quit ${NAME}`, click: quit },
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
  // Last resort: whatever won't stop (a stuck connection, a postgres that won't die), the program still exits.
  setTimeout(() => app.exit(0), 30_000);
  await stopServer();
  await pool?.end().catch(() => {});
  // Only a postgres this program started and that still runs: stopping one that has already gone never returns.
  if (dbOwned) await db.stop().catch((e) => log("postgres stop:", e));
  app.exit(0);
}

// ---------- start ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  app.on("window-all-closed", () => {}); // keep serving from the tray
  app.whenReady().then(async () => {
    guardSessions();
    for (;;) {
      try {
        cfg = loadConfig();
        break;
      } catch (e) {
        log("settings:", e);
        if (e instanceof SettingsError && (await settingsProblem(e))) continue;
        if (!(e instanceof SettingsError)) dialog.showErrorBox(`${NAME} couldn't start`, String(e instanceof Error ? e.message : e));
        return app.exit(1);
      }
    }
    log(`starting ${NAME} ${app.getVersion()}`);
    buildTray();
    applyLoginItem();
    try {
      await startDatabase();
      await startServer();
    } catch (e) {
      log("startup failed:", e);
      dialog.showErrorBox(`${NAME} couldn't start`, `${e instanceof Error ? e.message : e}\n\nLog: ${LOG_FILE}`);
      return quit();
    }
    // Specs, factory settings and the manual list that come with the program (a new install, or changed in an update).
    loadReference(pool, path.join(APP_DIR, "seed-data"), { library: !!cfg.libraryDir && fs.existsSync(cfg.libraryDir), log }).catch((e) =>
      log("reference data:", e),
    );
    buildTray(); // addresses can change while starting (Tailscale comes up late)
    setInterval(buildTray, 5 * 60_000);
    if (!process.argv.includes("--hidden") || signupOpen) showWindow();
    // Unless a restore has begun by then (on a new PC that's often the first thing done): it makes its own safety copy.
    if (Date.now() - lastBackupTime() > 26 * 3600_000) setTimeout(() => maintenance || runBackup("startup"), 60_000);
  });
}
