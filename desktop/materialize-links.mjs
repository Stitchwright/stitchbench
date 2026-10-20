// Next's standalone output links its external packages by absolute path into the build machine's folder, e.g.
// .next/node_modules/pg-<hash> -> /home/runner/work/.../.next/standalone/node_modules/pg. Anywhere else that link dangles, and
// codesign --strict refuses a bundle that has one ("invalid destination for symbolic link in bundle"). prepare-app.mjs
// replaces every symbolic link in the server folder with a real copy of what it points at.
import fs from "node:fs";
import path from "node:path";

/** @returns {string[]} the links that were replaced */
export function materializeLinks(dir) {
  const done = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) {
      let target;
      try {
        target = fs.realpathSync(p);
      } catch {
        throw new Error(`${p} is a symbolic link to ${fs.readlinkSync(p)}, which does not exist on this machine`);
      }
      fs.rmSync(p);
      fs.cpSync(target, p, { recursive: true, dereference: true });
      done.push(p);
    } else if (e.isDirectory()) {
      done.push(...materializeLinks(p));
    }
  }
  return done;
}

/** @returns {string[]} any symbolic links left under dir */
export function remainingLinks(dir) {
  const left = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) left.push(p);
    else if (e.isDirectory()) left.push(...remainingLinks(p));
  }
  return left;
}
