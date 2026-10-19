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
import https from "node:https";
import { spawn } from "node:child_process";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { migrate } from "./migrate.mjs";
import { backup, restore, listBackups, readManifest } from "./backup.mjs";
import { loadReference } from "./reference.mjs";
import { ensureAppRole, APP_ROLE } from "./app-role.mjs";
import { startLinksGate } from "./links-gate.mjs";
import { findTailscale, tailscaleStatus, serveStatus, serveOn, serveOff, linkIn } from "./tailscale.mjs";
import { isNewer, readRelease, verifyRelease, hashFile } from "./update.mjs";
import { RELEASE_PUBLIC_KEY } from "./release-key.mjs";
import { describeLogin, listLogins, loadBcrypt, MAX_LISTED, resetLogin } from "./reset-password.mjs";

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
let gate = null; // the links gate (links-gate.mjs), running while publicUrl is set
let quitting = false;
let signupOpen = false;
let setupToken = "";
// The server's door for a move file (src/lib/move/local.ts): a secret made at each server start, never sent anywhere else.
let moveSecret = "";
// The program's own window (src/lib/hub-reset-grants.ts): every request this program's windows make to its own address
// carries X-Stitch-Window with this secret, made at each server start and given only to the server. A browser tab or a
// tablet on the shop's network never has it, so what only the PC's window may see (a reset asked for on the owner's
// StitchHub account) is shown there and nowhere else.
let windowSecret = "";
// Companies on this PC that moved to another install (Shop.movedOutAt): the tray offers to remove their old copy.
let movedAway = [];
let stopping = false; // stopServer asked the server to exit
let starting = false; // startServer is waiting for it to answer
let dbOwned = false; // the postgres this program started is running (not one it only connected to, nor one that died)
let appRoleReady = false; // the server's limited database login (app-role.mjs) is set up; otherwise it gets the owner's
let maintenance = false; // a restore is replacing the data
let backingUp = 0; // backups running or waiting their turn
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
  const { dbPassword, appDbPassword, authSecret, ...plain } = c;
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
    // The optional link to a Foundry Account: "" (off), "offer" or "required" (src/lib/foundry/mode.ts, docs/plan.md FA-3).
    foundryLink: "",
    openAtLogin: true,
    // Customer links (estimate approval, unsubscribe) need an address customers can open. Set, the program serves
    // ONLY those pages on 127.0.0.1:linksPort (links-gate.mjs) for a tunnel the shop runs; see INSTALL.md.
    _publicUrl: "Optional https:// address customers can open (a tunnel you set up, pointed at the links port). Leave empty if unsure.",
    publicUrl: "",
    // The program's own https address for the shop's tablets and phones: browsers allow the barcode camera and the copy
    // buttons only on a secure page. The tray's "Secure address for tablets (Tailscale)" fills it in and remembers that
    // it did (tailscaleServe); a shop with a certificate of its own (INSTALL.md) writes secureUrl by hand. Not the same
    // thing as publicUrl: that one is for customers and serves only the public pages.
    _secureUrl: "Optional https:// address of this program for the shop's tablets and phones. The tray's Tailscale item fills it in; see INSTALL.md.",
    secureUrl: "",
    tailscaleServe: false,
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
  // The web server's own login (app-role.mjs). Made up here when missing (a first start, an update from before 1.6, a
  // secrets.json put back from an older copy): the program sets the role's password to this one at every start.
  const appDbPassword = secrets.appDbPassword || crypto.randomBytes(18).toString("base64url");
  if (secrets.dbPassword !== dbPassword || secrets.appDbPassword !== appDbPassword || secrets.authSecret !== authSecret) {
    writeAtomic(SECRETS_FILE, JSON.stringify({ dbPassword, appDbPassword, authSecret }, null, 2));
  }
  const c = { ...defaults, ...(saved ?? {}) };
  delete c.dbPassword;
  delete c.appDbPassword;
  delete c.authSecret;
  // First run: write the defaults so the settings file shows what can be changed. Also drops moved secrets.
  if (!saved || "dbPassword" in saved || "authSecret" in saved) writeConfig(c);
  // The links gate's port: next to the main port unless the settings file says otherwise (not written there by default).
  const linksPort = Number.parseInt(c.linksPort, 10);
  c.linksPort = linksPort > 0 ? linksPort : Number(c.port) + 1;
  return { ...c, dbPassword, appDbPassword, authSecret };
}

/**
 * The public address for customer links, checked: an https:// URL with nothing but a host (no path, user, query or
 * hash). { url, host } to use it (url without a trailing slash), or { why } when it is set but can't be used.
 */
function publicLinks(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  let u;
  try {
    u = new URL(text);
  } catch {
    return { why: `"${text}" isn't a web address` };
  }
  if (u.protocol !== "https:") return { why: "it must start with https://" };
  if (u.username || u.password) return { why: "it must not carry a user name or password" };
  if (u.pathname !== "/" && u.pathname !== "") return { why: "it must be an address only, with no path after the host" };
  if (u.search || u.hash) return { why: "it must have no ? or # part" };
  return { url: u.origin, host: u.host };
}

let publicLinksChecked;
/** The checked publicUrl, or null (with the reason logged once per start when it is set but unusable). */
function links() {
  if (publicLinksChecked === undefined) {
    const r = publicLinks(cfg.publicUrl);
    if (r?.why) log(`publicUrl ignored: ${r.why}`);
    publicLinksChecked = r?.url ? r : null;
  }
  return publicLinksChecked;
}

let secureChecked;
/**
 * The checked secureUrl (same rules as publicUrl: https, host only), or null, with the reason logged once per start. It
 * may not share publicUrl's host: the server serves only the public pages on that host (src/proxy.ts), so the program
 * itself would be 404 there.
 */
function secure() {
  if (secureChecked === undefined) {
    const r = publicLinks(cfg.secureUrl);
    if (r?.why) log(`secureUrl ignored: ${r.why}`);
    else if (r && links()?.host === r.host) log(`secureUrl ignored: it is publicUrl's address, which serves only the customer pages`);
    secureChecked = r?.url && links()?.host !== r.host ? r : null;
  }
  return secureChecked;
}

/** The links gate in front of the server, once it answers. Kept running across server restarts (it forwards by port). */
function startGate() {
  const l = links();
  if (!l || gate) return;
  if (Number(cfg.linksPort) === Number(cfg.port)) {
    log(`publicUrl ignored: linksPort ${cfg.linksPort} is the program's own port`);
    return;
  }
  try {
    const g = startLinksGate({ listenPort: cfg.linksPort, targetPort: cfg.port, publicHost: l.host });
    g.on("listening", () => log(`links gate on 127.0.0.1:${cfg.linksPort} for ${l.url}`));
    g.on("error", (e) => {
      log("links gate:", e);
      if (gate === g) gate = null;
    });
    gate = g;
  } catch (e) {
    log("links gate:", e);
  }
}

function stopGate() {
  const g = gate;
  gate = null;
  g?.close();
  g?.closeAllConnections?.();
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
  await setupAppRole();
}

/**
 * The server's limited login, made or brought up to date as the owner (after the migrations, and again after a restore).
 * If that fails the shop still opens: the server gets the owner's login as before 1.6, and the log says why.
 */
async function setupAppRole() {
  try {
    await ensureAppRole(pool, { password: cfg.appDbPassword, log });
    appRoleReady = true;
  } catch (e) {
    appRoleReady = false;
    log(`database: the server's login ${APP_ROLE} couldn't be set up; the server runs as the database owner instead:`, e);
  }
}

// The server's database address: the limited login when it is set up, otherwise the owner's (never both at once).
const databaseUrl = () =>
  appRoleReady
    ? `postgresql://${APP_ROLE}:${encodeURIComponent(cfg.appDbPassword)}@127.0.0.1:${cfg.dbPort}/stitchbench`
    : `postgresql://stitchbench:${encodeURIComponent(cfg.dbPassword)}@127.0.0.1:${cfg.dbPort}/stitchbench`;

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
  moveSecret = crypto.randomBytes(32).toString("base64url");
  windowSecret = crypto.randomBytes(32).toString("base64url");
  const child = spawn(process.execPath, [path.join(APP_DIR, "server.js")], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      // The Windows program: license checks ignore ModuleGrant rows and refuse development keys (src/lib/modules.ts).
      // After ...process.env on purpose, so the PC's own environment can't change it.
      STITCH_DESKTOP: "1",
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
      FOUNDRY_LINK: cfg.foundryLink || process.env.FOUNDRY_LINK || "",
      ALLOW_SIGNUP: signupOpen ? "true" : "false",
      SETUP_TOKEN: setupToken,
      // Only this program can ask the server to read a move file from disk (tray: Restore a company from a move file).
      MOVE_LOCAL_SECRET: moveSecret,
      // Marks this program's own window (see windowSecret).
      STITCH_WINDOW_SECRET: windowSecret,
      APP_NAME: NAME,
      DEFAULT_SHOP_KIND: FLAVOR === "stitchshop" ? "retail" : "repair",
      // The installer's version, told to StitchHub with each company's claim (src/lib/shops.ts programVersion).
      STITCH_VERSION: app.getVersion(),
      // Customer links: only with a checked public address, and then only the public pages on that host (src/proxy.ts),
      // behind the links gate. Neither variable otherwise. TRUST_PROXY is never set here.
      ...(links() ? { PUBLIC_URL: links().url, PUBLIC_LINKS_ONLY: "true" } : {}),
      // The program's own https address, when there is one: the app names it on non-secure pages when the camera or a
      // copy button needs a secure one (src/lib/secure-address.ts). Read once per server start (restartServer applies a change).
      ...(secure() ? { SECURE_URL: secure().url } : {}),
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
        startGate(); // only once the server answers: a tunnel reaching the gate earlier would get 502s
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

/** Stop and start the server (a setting it reads at start changed). Other devices reconnect by themselves. */
async function restartServer(why) {
  if (quitting || maintenance) return;
  log(`restarting the server: ${why}`);
  setStatus("restarting");
  await stopServer();
  try {
    await startServer();
    reloadWindow();
  } catch (e) {
    log("server restart failed:", e);
    serverDown("won't start");
  }
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
    buildTray(); // "Restore a company from a move file" is for a PC without one
  }
}, 15_000);

// ---------- addresses for other devices ----------

function addresses() {
  // The secure address first: it is the one tablets and phones should use (camera, copy buttons, and encrypted).
  const out = secure() ? [{ label: "Secure (https), for tablets and phones", url: secure().url }] : [];
  out.push({ label: `This PC's name`, url: `http://${os.hostname().toLowerCase()}:${cfg.port}` });
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

// ---------- the secure address (Tailscale) ----------

// What the tray knows about Tailscale on this PC; refreshed in the background (the tray menu is built synchronously).
const ts = { exe: null, running: false, dnsName: "", httpsEnabled: false, serving: false, funnel: false, busy: false };

/** Look again: is the CLI there, is it signed in, and does it serve our port? Then rebuild the tray. */
async function refreshTailscale() {
  try {
    ts.exe = await findTailscale();
    if (ts.exe) {
      const s = await tailscaleStatus(ts.exe);
      Object.assign(ts, { running: s.running, state: s.state, dnsName: s.dnsName, httpsEnabled: s.httpsEnabled });
      const sv = ts.running ? await serveStatus(ts.exe, cfg.port) : { on: false, funnel: false };
      ts.serving = sv.on;
      ts.funnel = sv.funnel;
    } else {
      Object.assign(ts, { running: false, dnsName: "", httpsEnabled: false, serving: false, funnel: false });
    }
  } catch (e) {
    log("tailscale:", e);
  }
  buildTray();
}

/** The address Tailscale serve gives this PC, from the device's DNS name. */
const tailscaleUrl = () => (ts.dnsName ? `https://${ts.dnsName}` : "");

/** Remember the secure address (or forget it) and make the server read it: SECURE_URL is set when it starts. */
async function applySecureUrl(url, { tailscale }) {
  saveSetting("secureUrl", url);
  saveSetting("tailscaleServe", tailscale);
  secureChecked = undefined;
  buildTray();
  await restartServer(url ? `secure address ${url}` : "secure address removed");
}

/** The remembered choice, put back if serve was reset outside the program (e.g. `tailscale serve reset`). */
async function reapplyTailscale() {
  if (!cfg.tailscaleServe || ts.busy || !ts.exe || !ts.running || ts.serving || !ts.dnsName) return;
  if (ts.funnel) return log("tailscale serve not turned on again: Funnel is on for port 443 (see the tray item)");
  try {
    await serveOn(ts.exe, cfg.port);
    ts.serving = true;
    log(`tailscale serve turned on again for ${tailscaleUrl()}`);
    if (secure()?.url !== tailscaleUrl()) await applySecureUrl(tailscaleUrl(), { tailscale: true });
  } catch (e) {
    log("tailscale serve couldn't be turned on again:", e);
  }
}

const box = (o) => dialog.showMessageBox({ title: `${NAME}: secure address for tablets`, ...o });

/** Tray → "Secure address for tablets (Tailscale)...": explain, check, turn on (or off), remember, restart the server. */
async function secureAddressDialog() {
  if (ts.busy) return;
  ts.busy = true;
  buildTray();
  try {
    await refreshTailscale();
    const why = `Browsers allow the barcode camera and the copy buttons only on a secure (https) page, so a tablet or phone on http://<pc>:${cfg.port} can't use them. Tailscale can give ${NAME} a secure address that works on every device signed in to your Tailscale network, in the shop and on the road, with nothing to install on the tablets but Tailscale itself.`;
    if (!ts.exe) {
      const r = await box({
        type: "info",
        message: "Tailscale isn't installed on this PC.",
        detail: `${why}\n\nInstall Tailscale (free for personal use and small teams) on this PC and on each tablet or phone, sign them all in to the same account, then come back to this menu item.`,
        buttons: ["Open tailscale.com/download", "Close"],
        defaultId: 0,
        cancelId: 1,
      });
      if (r.response === 0) shell.openExternal("https://tailscale.com/download");
      return;
    }
    if (!ts.running || !ts.dnsName) {
      await box({
        type: "warning",
        message: "Tailscale is installed but not connected.",
        detail: `Open Tailscale from its own tray icon, sign in (or press Connect), then try again.${ts.running ? "" : `\n\nTailscale says: ${ts.state ?? "not running"}.`}`,
        buttons: ["Close"],
      });
      return;
    }
    if (ts.serving && cfg.tailscaleServe) {
      // Already on: offer to turn it off.
      const r = await box({
        type: "question",
        message: `The secure address is on: ${tailscaleUrl()}`,
        detail: `Tablets and phones on your Tailscale network open ${NAME} there. Turning it off removes the address; the plain http addresses keep working. ${NAME}'s server restarts for a few seconds either way.`,
        buttons: ["Copy the address", "Turn off", "Close"],
        defaultId: 0,
        cancelId: 2,
      });
      if (r.response === 0) clipboard.writeText(tailscaleUrl());
      if (r.response === 1) {
        await serveOff(ts.exe);
        ts.serving = false;
        log("tailscale serve turned off");
        // A secureUrl written by hand for another arrangement is left alone; only the Tailscale one is forgotten.
        await applySecureUrl(cfg.secureUrl === tailscaleUrl() ? "" : cfg.secureUrl, { tailscale: false });
        notify(NAME, "The secure address is off.");
      }
      return;
    }
    if (ts.funnel) {
      await box({
        type: "error",
        message: "Tailscale Funnel is on for port 443 on this PC.",
        detail: `Serving ${NAME} on that port would put the whole program on the public internet. If the funnel is for customer links (publicUrl), move it to another port first, e.g.\n\ntailscale funnel --bg --https=8443 http://127.0.0.1:${cfg.linksPort}\n\nand set publicUrl to the :8443 address. Then try again.`,
        buttons: ["Close"],
      });
      return;
    }
    if (!ts.httpsEnabled) {
      const r = await box({
        type: "warning",
        message: "HTTPS certificates aren't enabled for your Tailscale network.",
        detail: "In the Tailscale admin console, on the DNS page, turn on MagicDNS and HTTPS Certificates (one click each, free). Then try again.",
        buttons: ["Open the DNS page", "Close"],
        defaultId: 0,
        cancelId: 1,
      });
      if (r.response === 0) shell.openExternal("https://login.tailscale.com/admin/dns");
      return;
    }
    const r = await box({
      type: "question",
      message: `Give tablets and phones a secure address?`,
      detail: `${why}\n\n${NAME} will be at\n\n${tailscaleUrl()}\n\nfor every device on your Tailscale network, and only for them. The address stays on until you turn it off here, and ${NAME}'s server restarts for a few seconds now so its pages can name it.`,
      buttons: ["Turn on", "Cancel"],
      defaultId: 0,
      cancelId: 1,
    });
    if (r.response !== 0) return;
    try {
      await serveOn(ts.exe, cfg.port);
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      log("tailscale serve:", text);
      const link = linkIn(text);
      const r2 = await box({
        type: "error",
        message: "Tailscale couldn't set up the address.",
        detail: `${text}${link ? "\n\nTailscale may need an admin to approve this on the page it names. Open it, approve, then try again." : ""}`,
        buttons: link ? ["Open the page", "Close"] : ["Close"],
        defaultId: 0,
        cancelId: link ? 1 : 0,
      });
      if (link && r2.response === 0) shell.openExternal(link);
      return;
    }
    ts.serving = true;
    log(`tailscale serve on: ${tailscaleUrl()} -> http://127.0.0.1:${cfg.port}`);
    await applySecureUrl(tailscaleUrl(), { tailscale: true });
    clipboard.writeText(tailscaleUrl());
    await box({
      type: "info",
      message: `${NAME} is now at ${tailscaleUrl()}`,
      detail: "The address is copied to the clipboard and listed first under \"Address for other devices\". Open it on each tablet or phone (signed in to Tailscale) and bookmark it. The first visit can take a few seconds while Tailscale fetches the certificate.",
      buttons: ["Close"],
    });
  } catch (e) {
    log("secure address:", e);
    dialog.showErrorBox(`${NAME}: secure address`, String(e instanceof Error ? e.message : e));
  } finally {
    ts.busy = false;
    buildTray();
  }
}

/** The tray item's label says where things stand without opening anything. */
function secureAddressLabel() {
  if (ts.busy) return "Secure address for tablets (Tailscale): working...";
  if (ts.serving && cfg.tailscaleServe) return "Secure address for tablets (Tailscale): on...";
  return "Secure address for tablets (Tailscale)...";
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
  backingUp++;
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
    backingUp--;
    buildTray();
  }
}

function lastBackupTime() {
  const [latest] = listBackups(cfg.backupDir, FLAVOR);
  return latest ? fs.statSync(latest).mtimeMs : 0;
}

setInterval(() => {
  // A backup still running (a big photo table, a slow NAS) has no finished folder yet, so the last one still looks old:
  // don't queue another behind it.
  if (!pool || quitting || maintenance || backingUp) return;
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
        await setupAppRole(); // cheap, and covers a restore that touched what the server may use
        dialog.showMessageBox({
          message: "Backup restored.",
          detail: `The data from just before is saved in:\n${saved}\n\nMarketing messages are on hold until an owner or admin checks Messages -> Opt-outs and presses Resume.`,
        });
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

/**
 * "Reset a password...": the person at the shop PC picks a login and gets a new password, shown once here and nowhere
 * else (hub-accounts-billing-design.md 4.3.3). Needs the PC and nothing more: no email, no internet, no hub.
 */
async function resetPasswordDialog() {
  if (!pool) return;
  const logins = await listLogins(pool);
  if (!logins.length) {
    dialog.showMessageBox({ title: `${NAME}: reset a password`, message: "There are no logins yet.", detail: `Open ${NAME} and create the company first.` });
    return;
  }
  const several = new Set(logins.map((l) => l.shop)).size > 1;
  const shown = logins.slice(0, MAX_LISTED);
  const pick = await dialog.showMessageBox({
    type: "question",
    title: `${NAME}: reset a password`,
    message: "Whose password?",
    detail: `A new password is made and shown once, on this screen only. Every device signed in as that person is signed out.${logins.length > shown.length ? `\n\nOnly the first ${shown.length} logins are listed; an owner can reset the others in ${NAME} under Settings.` : ""}`,
    buttons: [...shown.map((l) => describeLogin(l, several)), "Cancel"],
    cancelId: shown.length,
    defaultId: shown.length,
    noLink: true,
  });
  const login = shown[pick.response];
  if (!login) return;
  const password = await resetLogin(pool, loadBcrypt(APP_DIR), login.id);
  log(`password reset from the tray for ${login.email}`);
  const done = await dialog.showMessageBox({
    type: "info",
    title: `${NAME}: new password`,
    message: `New password for ${login.name} (${login.email})`,
    detail: `${password}\n\nIt is shown only here, now. Sign in with it, then change it under Settings if you like.`,
    buttons: ["Copy and close", "Close"],
    defaultId: 0,
    noLink: true,
  });
  if (done.response === 0) clipboard.writeText(password);
}

// ---------- a company from a move file ----------

/** This PC is set up to keep several companies (platformAdminEmails; company-move-design.md decision 13). */
const hostsMany = () =>
  String(cfg?.platformAdminEmails ?? "")
    .split(",")
    .some((e) => e.trim());

/**
 * A one-use token for the server's door (src/lib/move/local.ts takeMoveToken, the same sum): an HMAC under the secret
 * this program gave the server at start, of a fresh nonce, an expiry two minutes on and the file's path.
 */
function moveToken(file) {
  const nonce = crypto.randomBytes(16).toString("base64url");
  const until = String(Date.now() + 120_000);
  const mac = crypto.createHmac("sha256", moveSecret).update(`${nonce}.${until}.${file}`).digest("base64url");
  return `${nonce}.${until}.${mac}`;
}

/**
 * Tray → "Restore a company from a move file..." (and the first-run page's link to /move-in?choose=1): pick the file
 * the other install made, and the server reads it from disk and imports it (company-move-design.md section 8): no
 * upload, no size limit but the disk's. Only while this PC has no company, or is set up to host several; the server
 * checks that again. The window then shows the progress, what to enter again, and the way to sign in.
 */
async function restoreMoveFile() {
  if (!pool || maintenance) return;
  const title = `${NAME}: restore a company`;
  if (!server) {
    dialog.showErrorBox(title, `${NAME} isn't running right now. Try again in a minute.`);
    return;
  }
  const shops = Number((await pool.query(`SELECT count(*) AS n FROM "Shop"`)).rows[0].n);
  if (shops > 0 && !hostsMany()) {
    await dialog.showMessageBox({
      type: "info",
      title,
      message: `${NAME} on this PC already has its company.`,
      detail:
        "A move file brings a company to a PC that has none yet (the first time the program runs). To keep several companies on one PC, set platformAdminEmails in the settings file first (see INSTALL.md).",
    });
    return;
  }
  const pick = await dialog.showOpenDialog({
    title: "Choose the move file",
    properties: ["openFile"],
    filters: [
      { name: "Move files", extensions: ["gz"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (pick.canceled || !pick.filePaths[0]) return;
  const file = pick.filePaths[0];
  const ok = await dialog.showMessageBox({
    type: "question",
    buttons: ["Restore", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    title,
    message: `Bring in the company in ${path.basename(file)}?`,
    detail: `Every line of the file is checked first: if anything is wrong, nothing is added and you are told why. The file stays where it is.${shops > 0 ? " The data already here is backed up first." : ""}`,
  });
  if (ok.response !== 0) return;
  if (shops > 0 && !(await runBackup("before importing a company", { prune: false }))) {
    dialog.showErrorBox(title, `The current data couldn't be backed up first, so nothing was imported.\n\nLog: ${LOG_FILE}`);
    return;
  }
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${cfg.port}/api/move/local`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-move-token": moveToken(file) },
      body: JSON.stringify({ path: file }),
    });
  } catch (e) {
    dialog.showErrorBox(title, `${NAME} didn't answer: ${e instanceof Error ? e.message : e}`);
    return;
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.job) {
    dialog.showErrorBox(title, body.error ?? `${NAME} refused the file (${res.status}).`);
    return;
  }
  log(`importing a company from ${file}`);
  showWindow();
  win?.loadURL(`${base()}/move-in/${encodeURIComponent(body.job)}`);
}

// ---------- the old copy of a company that moved ----------

const KEEP_MOVED_DAYS = 30; // as src/lib/move/format.ts: the old copy is kept this long after the company moved

/** The companies here that moved to another install, for the tray item; the tray is rebuilt when the list changes. */
async function refreshMovedAway() {
  if (!pool || maintenance) return;
  try {
    const rows = (await pool.query(`SELECT id, name, "movedTo", "movedOutAt" FROM "Shop" WHERE "movedOutAt" IS NOT NULL ORDER BY "movedOutAt"`)).rows;
    const changed = JSON.stringify(rows) !== JSON.stringify(movedAway);
    movedAway = rows;
    if (changed) buildTray();
  } catch {
    /* a database from before the move columns: nothing has moved */
  }
}
setInterval(() => refreshMovedAway(), 10 * 60_000);

/**
 * Tray → "Remove the moved company..." (company-move-design.md section 7): a company that moved to another install
 * leaves its old copy here, read-only. From 30 days after it moved, this removes it: a backup first, then the server
 * deletes it through its own door (/api/move/remove, a one-use token as for a move file), under the same rules as the
 * hosted Companies page. Nothing removes it by itself.
 */
async function removeMovedCompany() {
  if (!pool || maintenance) return;
  const title = `${NAME}: remove a moved company`;
  await refreshMovedAway();
  if (!movedAway.length) {
    await dialog.showMessageBox({ type: "info", title, message: "No company on this PC has moved to another install." });
    return;
  }
  const shown = movedAway.slice(0, 6);
  let pick = 0;
  if (shown.length > 1) {
    pick = (
      await dialog.showMessageBox({
        type: "question",
        title,
        message: "Which company's old copy?",
        buttons: [...shown.map((c) => c.name), "Cancel"],
        cancelId: shown.length,
        defaultId: shown.length,
        noLink: true,
      })
    ).response;
  }
  const c = shown[pick];
  if (!c) return;
  const at = new Date(c.movedOutAt);
  const from = new Date(at.getTime() + KEEP_MOVED_DAYS * 86_400_000);
  const where = c.movedTo ? ` to ${c.movedTo}` : "";
  if (Date.now() < from.getTime()) {
    await dialog.showMessageBox({
      type: "info",
      title,
      message: `${c.name} moved${where} on ${at.toLocaleDateString()}.`,
      detail: `Its copy here is kept ${KEEP_MOVED_DAYS} days in case the move has to be undone. It can be removed from ${from.toLocaleDateString()}.`,
    });
    return;
  }
  if (!server) {
    dialog.showErrorBox(title, `${NAME} isn't running right now. Try again in a minute.`);
    return;
  }
  const ok = await dialog.showMessageBox({
    type: "warning",
    title,
    message: `Remove ${c.name} from this PC?`,
    detail: `It moved${where} on ${at.toLocaleDateString()} and runs there now. Everything of it here goes: customers, machines, tickets, photos, sales and logins. A backup of this PC's data is made first.`,
    checkboxLabel: `I understand ${c.name} is deleted from this PC`,
    buttons: ["Remove", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (ok.response !== 0) return;
  if (!ok.checkboxChecked) {
    await dialog.showMessageBox({ type: "info", title, message: "Nothing was removed.", detail: "Tick the box to say you understand, then try again." });
    return;
  }
  if (!(await runBackup("before removing a moved company", { prune: false }))) {
    dialog.showErrorBox(title, `This PC's data couldn't be backed up first, so nothing was removed.\n\nLog: ${LOG_FILE}`);
    return;
  }
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${cfg.port}/api/move/remove`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-move-token": moveToken(`remove:${c.id}`) },
      body: JSON.stringify({ shopId: c.id, name: c.name }),
    });
  } catch (e) {
    dialog.showErrorBox(title, `${NAME} didn't answer: ${e instanceof Error ? e.message : e}`);
    return;
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    dialog.showErrorBox(title, body.error ?? `${NAME} refused (${res.status}).`);
    return;
  }
  log(`removed the old copy of ${c.name} (${c.id}), which moved${where} on ${at.toISOString()}`);
  await refreshMovedAway();
  const left = Number((await pool.query(`SELECT count(*) AS n FROM "Shop"`)).rows[0].n);
  if (left > 0) {
    notify(NAME, `${c.name} was removed from this PC.`);
    win?.loadURL(home());
    return;
  }
  // The PC has no company now: a restart opens the first-run page (a new company, or one from a move file).
  const again = await dialog.showMessageBox({
    type: "info",
    title,
    message: `${c.name} was removed. This PC has no company now.`,
    detail: `Restart ${NAME} to set one up (or bring one in from a move file), or uninstall it if this PC is done with it.`,
    buttons: [`Restart ${NAME}`, "Later"],
    defaultId: 0,
    cancelId: 1,
  });
  if (again.response === 0) {
    app.relaunch();
    quit();
  }
}

/** The program's own link /program/update (the "Update now" button of the new-version banner). */
function updateDoor(url) {
  if (!isApp(url)) return false;
  return new URL(url).pathname === "/program/update";
}

// ---------- updating the program (docs/plans/ease-of-use-design.md section 1) ----------

let updating = false;

function hubBase() {
  return (process.env.DEFAULT_HUB_URL ?? "https://hub.stitchbench.app").replace(/\/+$/, "");
}

/** Downloads `url` (https only, up to 5 redirects) to `file`, reporting 0..1 progress. Rejects on anything odd. */
function downloadTo(url, file, expectSize, onProgress, hops = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return reject(new Error("bad download address"));
    }
    if (u.protocol !== "https:") return reject(new Error("download address is not https"));
    const req = https.get(u, { headers: { "User-Agent": `${NAME}/${app.getVersion()}` } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (hops >= 5) return reject(new Error("too many redirects"));
        return downloadTo(new URL(res.headers.location, u).href, file, expectSize, onProgress, hops + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`download answered ${res.statusCode}`));
      }
      const out = fs.createWriteStream(file);
      let got = 0;
      res.on("data", (d) => {
        got += d.length;
        if (got > expectSize) req.destroy(new Error("file bigger than announced"));
        else onProgress(got / expectSize);
      });
      res.on("error", reject);
      out.on("error", reject);
      out.on("finish", () => resolve(got));
      res.pipe(out);
    });
    req.setTimeout(60_000, () => req.destroy(new Error("download timed out")));
    req.on("error", reject);
  });
}

/** A small window with a message while the new version downloads. */
function progressWindow() {
  const w = new BrowserWindow({
    width: 440,
    height: 150,
    resizable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    title: NAME,
    icon: ICON,
    parent: win ?? undefined,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  const html = `<body style="font:22px Segoe UI,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;color:#222">Downloading the new version…</body>`;
  void w.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  return w;
}

async function updateFailed(reason) {
  log("update failed:", reason);
  win?.setProgressBar(-1);
  await dialog.showMessageBox(win ?? undefined, {
    type: "warning",
    title: NAME,
    message: "The update didn't work. Nothing was changed.",
    detail: String(reason),
    buttons: ["OK"],
  });
}

/** Asks the hub for the latest release of this program; null when there is none. Throws on a failed call. */
async function latestRelease() {
  const res = await fetch(`${hubBase()}/v1/releases/latest?flavor=${FLAVOR}`, { signal: AbortSignal.timeout(15_000), headers: { Accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`the update service answered ${res.status}`);
  const r = readRelease(await res.json());
  if (!r) throw new Error("the update service sent something unexpected");
  return r;
}

/** Tray "Check for a new version" and the page's /program/update link. Asks the hub itself; nothing comes from the page. */
async function updateProgram({ fromTray }) {
  if (updating) return;
  updating = true;
  buildTray();
  let tmp = "";
  try {
    let release;
    try {
      release = await latestRelease();
    } catch (e) {
      return await updateFailed(`Could not reach the update service (${e instanceof Error ? e.message : e}).`);
    }
    if (!release || !isNewer(release.version, app.getVersion())) {
      log(`update check${fromTray ? " (tray)" : ""}: already on the newest version`);
      await dialog.showMessageBox(win ?? undefined, { type: "info", title: NAME, message: "You have the newest version.", buttons: ["OK"] });
      return;
    }
    const ask = await dialog.showMessageBox(win ?? undefined, {
      type: "question",
      title: NAME,
      message: `Update ${NAME} now?`,
      detail:
        process.platform === "win32"
          ? "It saves a backup, closes, and opens again by itself in a minute or two. Tablets and other computers reconnect by themselves."
          : "This opens the downloads page. Install the new version over this one; your data stays where it is.",
      buttons: ["Update now", "Not now"],
      defaultId: 0,
      cancelId: 1,
    });
    if (ask.response !== 0) return;
    // The silent in-place install is the Windows installer's /S switch. On macOS and Linux the new version is
    // installed by hand: open the downloads page (the release is the same one the hub points at).
    if (process.platform !== "win32") {
      await shell.openExternal("https://github.com/stitchwright/stitchbench/releases/latest");
      return;
    }
    if (!RELEASE_PUBLIC_KEY) return await updateFailed("This copy can't check that the new version is genuine yet.");
    if (!pool || maintenance) return await updateFailed("The program is busy with something else. Try again in a minute.");

    tmp = fs.mkdtempSync(path.join(os.tmpdir(), `${FLAVOR}-update-`));
    const exe = path.join(tmp, `${NAME}-Setup-${release.version}.exe`);
    const pw = progressWindow();
    try {
      await downloadTo(release.url, exe, release.size, (f) => win?.setProgressBar(Math.min(0.99, f)));
    } finally {
      win?.setProgressBar(-1);
      if (!pw.isDestroyed()) pw.destroy();
    }
    const got = await hashFile(exe);
    if (got.size !== release.size) throw new Error("the downloaded file is the wrong size");
    if (got.sha256 !== release.sha256) throw new Error("the downloaded file doesn't match");
    if (!verifyRelease(RELEASE_PUBLIC_KEY, { flavor: FLAVOR, version: release.version, sha256: got.sha256, size: got.size }, release.signature)) {
      throw new Error("the new version isn't signed by us");
    }
    const saved = await runBackup("before update", { prune: false });
    if (!saved) throw new Error("the backup couldn't be made first");
    log(`update ${app.getVersion()} -> ${release.version}: starting ${exe}`);
    // Wait a few seconds so this program has closed (and let go of its files) before the installer starts; /S is the
    // installer's silent mode and --force-run opens the program again afterwards.
    const child = spawn("cmd.exe", ["/d", "/s", "/c", `"ping -n 9 127.0.0.1 >nul & "${exe}" /S --force-run"`], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
    child.unref();
    tmp = ""; // the installer still has to run from there
    void quit();
  } catch (e) {
    await updateFailed(e instanceof Error ? e.message : e);
  } finally {
    updating = false;
    buildTray();
    if (tmp) fs.rm(tmp, { recursive: true, force: true }, () => {});
  }
}

/** The program's own links on its pages: /move-in?choose=1 opens the file dialog, /move-in?home=1 goes back to the start page. */
function moveDoor(url) {
  if (!isApp(url)) return null;
  const u = new URL(url);
  if (u.pathname !== "/move-in") return null;
  return u.searchParams.get("choose") === "1" ? "choose" : u.searchParams.get("home") === "1" ? "home" : null;
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
  // The program's own window says so on every request to the program's own address, and on nothing else (windowSecret).
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    for (const name of Object.keys(headers)) if (name.toLowerCase() === "x-stitch-window") delete headers[name];
    if (windowSecret && isApp(details.url)) headers["X-Stitch-Window"] = windowSecret;
    callback({ requestHeaders: headers });
  });
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
        if (updateDoor(url)) {
          e.preventDefault();
          void updateProgram({ fromTray: false });
          return;
        }
        const door = moveDoor(url);
        if (door) {
          e.preventDefault();
          if (door === "home") win?.loadURL(home());
          else restoreMoveFile().catch((err) => dialog.showErrorBox(NAME, String(err instanceof Error ? err.message : err)));
          return;
        }
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
      { label: secureAddressLabel(), enabled: !ts.busy && !maintenance && !!pool, click: () => secureAddressDialog() },
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
      // A company from another install's move file: on a PC without one yet, or one set up to host several.
      ...(signupOpen || hostsMany()
        ? [
            {
              label: signupOpen ? "Restore a company from a move file..." : "Import a company from a move file...",
              enabled: !maintenance && !!pool,
              click: () => restoreMoveFile().catch((e) => dialog.showErrorBox(NAME, String(e instanceof Error ? e.message : e))),
            },
          ]
        : []),
      // The old copy of a company that moved to another install: removed by hand, 30 days on.
      ...(movedAway.length
        ? [
            {
              label: "Remove the moved company...",
              enabled: !maintenance && !!pool,
              click: () => removeMovedCompany().catch((e) => dialog.showErrorBox(NAME, String(e instanceof Error ? e.message : e))),
            },
          ]
        : []),
      {
        label: "Reset a password...",
        enabled: !maintenance && !!pool,
        click: () => resetPasswordDialog().catch((e) => dialog.showErrorBox(`${NAME}: reset a password`, String(e instanceof Error ? e.message : e))),
      },
      { type: "separator" },
      { label: "Check for a new version", enabled: !updating && !maintenance && !!pool, click: () => void updateProgram({ fromTray: true }) },
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
  stopGate();
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
    refreshMovedAway(); // a company that moved away: "Remove the moved company..." in the tray
    refreshTailscale().then(reapplyTailscale); // in the background: the CLI may take a moment
    setInterval(() => refreshTailscale().then(reapplyTailscale), 5 * 60_000);
    if (!process.argv.includes("--hidden") || signupOpen) showWindow();
    // Unless a restore has begun by then (on a new PC that's often the first thing done): it makes its own safety copy.
    if (Date.now() - lastBackupTime() > 26 * 3600_000) setTimeout(() => maintenance || backingUp || runBackup("startup"), 60_000);
  });
}
