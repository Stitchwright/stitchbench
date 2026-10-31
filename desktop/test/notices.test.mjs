// THIRD_PARTY_NOTICES.txt (third-party-notices.mjs): every shipped package with its license texts, the wrapper's build
// tools left out, the LGPL libraries' README (where sharp's libvips lists what it bundles) and the license texts at the
// end. No database needed.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeNotices } from "../third-party-notices.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);

function pkg(dir, meta, files = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(meta));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
}

test("notices: shipped packages with their licenses, build tools left out, license texts appended", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "notices-"));
  const server = path.join(tmp, "server");
  const desktop = path.join(tmp, "desktop");
  // The server's packages, already renamed to _node_modules as prepare-app ships them, one nested.
  pkg(path.join(server, "_node_modules", "left-pad"), { name: "left-pad", version: "1.3.0", license: "WTFPL", repository: "git+https://github.com/x/left-pad.git" }, { LICENSE: "left-pad license text" });
  pkg(path.join(server, "_node_modules", "@img", "sharp-libvips-win32-x64"), { name: "@img/sharp-libvips-win32-x64", version: "1.2.4", license: "LGPL-3.0-or-later" }, { "README.md": "| libvips | LGPLv3 |" });
  pkg(path.join(server, "_node_modules", "left-pad", "_node_modules", "inner"), { name: "inner", version: "2.0.0", license: "MIT" }, { "LICENSE.md": "inner MIT text" });
  // The wrapper: pg ships, electron (a build tool) doesn't.
  pkg(path.join(desktop, "node_modules", "pg"), { name: "pg", version: "8.16.3", license: "MIT" }, { LICENSE: "pg license text" });
  pkg(path.join(desktop, "node_modules", "electron"), { name: "electron", version: "44.4.5", license: "MIT" }, { LICENSE: "electron license text" });
  fs.writeFileSync(
    path.join(desktop, "package-lock.json"),
    JSON.stringify({ packages: { "": {}, "node_modules/pg": { version: "8.16.3" }, "node_modules/electron": { version: "44.4.5", dev: true } } }),
  );
  fs.cpSync(path.join(here, "..", "licenses"), path.join(desktop, "licenses"), { recursive: true });

  const { out, count } = writeNotices(server, desktop, "9.9.9");
  const text = fs.readFileSync(out, "utf8");
  assert.equal(count, 4);
  assert.match(text, /^Third-party software in StitchBench 9\.9\.9/);
  assert.match(text, /GNU Affero General Public License/);
  assert.match(text, /left-pad@1\.3\.0: WTFPL\nSource: https:\/\/github\.com\/x\/left-pad/);
  assert.match(text, /left-pad license text/);
  assert.match(text, /inner@2\.0\.0: MIT/);
  assert.match(text, /pg license text/);
  assert.match(text, /\| libvips \| LGPLv3 \|/, "an LGPL package's README is included");
  assert.doesNotMatch(text, /electron license text/, "build tools don't ship");
  assert.match(text, /GNU LESSER GENERAL PUBLIC LICENSE/);
  assert.match(text, /GNU GENERAL PUBLIC LICENSE/);
  assert.match(text, /PostgreSQL Database Management System/);
  fs.rmSync(tmp, { recursive: true, force: true });
});
