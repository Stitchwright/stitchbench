// A signed macOS app must not change after it is signed: the program renames the server's _node_modules folders on its first
// start (main.mjs, unpackModules), which would break the signature and fails on a read-only or translocated app. So on
// macOS the server folder is copied once per build into the program's own data folder, and the program runs it from there.
import fs from "node:fs";
import path from "node:path";

/**
 * @param {string} from the bundled server folder (inside the app, never written)
 * @param {string} to   the writable copy
 * @returns {string} `to`, filled from `from` unless it already holds this build
 */
export function writableServerDir(from, to) {
  const stamp = `${fs.statSync(path.join(from, "server.js")).mtimeMs}:${fs.statSync(from).mtimeMs}`;
  const marker = path.join(to, ".bundled-from");
  try {
    if (fs.readFileSync(marker, "utf8") === stamp) return to;
  } catch {
    // no copy yet, or an unfinished one (the marker is written last): copy again
  }
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
  fs.writeFileSync(marker, stamp);
  return to;
}
