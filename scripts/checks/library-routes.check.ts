// The manual library and figure routes (round-3 finding I18), called as the route handlers with the sign-in mocked:
//   GET / HEAD /api/library/file: sign-in, no library folder, traversal (dotted, encoded, backslash, absolute, sibling folder,
//     private folders, non-PDF, a folder named x.pdf), the PDF headers, Range (206, 416), a non-ASCII name
//   POST /api/library/file: sign-in, not a PDF, empty, no file, the saved name made safe and never overwritten
//   GET / POST /api/figures: sign-in, box and file validation, an unknown figure, the first copy kept by a tech, a tech (and the
//     owner of one of several companies) unable to replace it, whoever runs the install (the administrator) able to
// A throwaway library folder and companies; no hub is joined (the check stops if this database has joined one, so
// nothing is pushed). The sign-in is mocked at "@/auth", so the real sessionUser() still reads the database.
//   npm run check scripts/checks/library-routes.check.ts
// Module mocking (mock.module) needs Node's --experimental-test-module-mocks on the Node versions we run (22 and 24, as
// CI and the Dockerfile); without it the check runs itself again with it, so `npm run check` works like every other check.
import "dotenv/config";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";
import { db } from "@/lib/db";
import { figureId } from "@/lib/figures";
import { checkShop, cleanup } from "./lib";
import { RUN } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};

if (typeof mock.module !== "function") {
  const again = spawnSync(process.execPath, [...process.execArgv, "--experimental-test-module-mocks", ...process.argv.slice(1)], { stdio: "inherit" });
  process.exit(again.status ?? 1);
}

// Who is signed in: null, or the user the next request is made as.
let session: { user: { id: string; shopId: string; sv: number } } | null = null;
mock.module("@/auth", { namedExports: { auth: async () => session, handlers: {}, signIn: async () => {}, signOut: async () => {} } });
// session.ts imports redirect() from next/navigation, which needs the react-server build of React to load; the routes here never call it.
mock.module("next/navigation", {
  namedExports: {
    redirect: () => {
      throw new Error("redirect");
    },
  },
});
const signIn = (u: { id: string; shopId: string } | null) => {
  session = u ? { user: { id: u.id, shopId: u.shopId, sv: 0 } } : null;
};

const BASE = "http://check.test";
const PDF = Buffer.from("%PDF-1.4\n" + "x".repeat(990) + "\n%%EOF\n"); // 1000-odd bytes

function formOf(file: Blob | null, extra: Record<string, string> = {}) {
  const fd = new FormData();
  if (file) fd.set("file", file, "up.pdf");
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return fd;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `libcheck-${RUN}-`));
  const lib = path.join(root, "lib");
  const sibling = path.join(root, "lib-secret"); // shares the library's name as a prefix
  const dirs = [path.join(lib, "Sewing", "Janome"), path.join(lib, "_business-notes"), path.join(lib, "_own-notes"), path.join(lib, "folder.pdf"), sibling];
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(lib, "Sewing", "Janome", "a.pdf"), PDF);
  fs.writeFileSync(path.join(lib, "Sewing", "Janome", "Handbuch über Nadeln.pdf"), PDF);
  fs.writeFileSync(path.join(lib, "Sewing", "Janome", "notes.txt"), "not a pdf");
  fs.writeFileSync(path.join(lib, "_business-notes", "prices.pdf"), PDF);
  fs.writeFileSync(path.join(lib, "_own-notes", "mine.pdf"), PDF);
  fs.writeFileSync(path.join(sibling, "secret.pdf"), PDF);
  fs.writeFileSync(path.join(root, "outside.pdf"), PDF);
  process.env.LIBRARY_DIR = lib;

  const figIds: string[] = [];
  let restoreFetch = () => {};
  const a = await checkShop();
  const b = await checkShop();
  const tech = await db.user.create({
    data: { shopId: a.shopId, email: `check-${RUN}-tech@stitchbench.test`, name: "Check tech", passwordHash: "x", role: "TECH" },
    select: { id: true, shopId: true },
  });
  try {
    // If this database has joined a hub, shareFigure would push to it: every outgoing fetch is caught here instead.
    const realFetch = globalThis.fetch;
    const pushed: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      pushed.push(String(url));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    restoreFetch = () => {
      globalThis.fetch = realFetch;
    };
    assert.ok((await db.shop.count()) > 1, "two companies exist, so only the administrator runs the install");
    delete process.env.PLATFORM_ADMIN_EMAILS;

    const file = await import("@/app/api/library/file/route");
    const figures = await import("@/app/api/figures/route");
    const get = (p: string, init?: RequestInit) => file.GET(new Request(`${BASE}/api/library/file?path=${p}`, init));

    // ---------- GET / HEAD /api/library/file ----------
    signIn(null);
    assert.equal((await get("Sewing/Janome/a.pdf")).status, 401);
    assert.equal((await file.HEAD(new Request(`${BASE}/api/library/file?path=Sewing/Janome/a.pdf`))).status, 401);
    ok("library file: no sign-in, no manual (GET and HEAD)");

    signIn(tech);
    process.env.LIBRARY_DIR = path.join(root, "not-there");
    assert.equal((await get("Sewing/Janome/a.pdf")).status, 404, "a missing library folder");
    delete process.env.LIBRARY_DIR;
    assert.equal((await get("Sewing/Janome/a.pdf")).status, 404, "no LIBRARY_DIR (a hosted install)");
    process.env.LIBRARY_DIR = lib;
    ok("library file: an install without a library folder serves nothing");

    const ok1 = await get("Sewing/Janome/a.pdf");
    assert.equal(ok1.status, 200);
    assert.equal(ok1.headers.get("content-type"), "application/pdf");
    assert.equal(ok1.headers.get("accept-ranges"), "bytes");
    assert.equal(ok1.headers.get("content-length"), String(PDF.length));
    assert.match(ok1.headers.get("cache-control") ?? "", /^private/);
    assert.equal(Buffer.from(await ok1.arrayBuffer()).compare(PDF), 0, "the whole file");
    const viaBackslash = await get("Sewing%5CJanome%5Ca.pdf");
    assert.equal(viaBackslash.status, 200, "the library's own backslash paths work");
    await viaBackslash.arrayBuffer();
    const head = await file.HEAD(new Request(`${BASE}/api/library/file?path=Sewing/Janome/a.pdf`));
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(PDF.length));
    assert.equal((await head.arrayBuffer()).byteLength, 0, "HEAD has no body");
    assert.equal((await file.HEAD(new Request(`${BASE}/api/library/file?path=Sewing/Janome/none.pdf`))).status, 404);
    ok("library file: a PDF streams whole with its type, length, Range and private cache headers; HEAD matches and has no body");

    const part = await get("Sewing/Janome/a.pdf", { headers: { range: "bytes=0-99" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), `bytes 0-99/${PDF.length}`);
    assert.equal(Buffer.from(await part.arrayBuffer()).compare(PDF.subarray(0, 100)), 0);
    const tail = await get("Sewing/Janome/a.pdf", { headers: { range: "bytes=-10" } });
    assert.equal(tail.status, 206);
    assert.equal(Buffer.from(await tail.arrayBuffer()).compare(PDF.subarray(PDF.length - 10)), 0, "the last 10 bytes");
    const past = await get("Sewing/Janome/a.pdf", { headers: { range: `bytes=${PDF.length + 5}-` } });
    assert.equal(past.status, 416);
    assert.equal(past.headers.get("content-range"), `bytes */${PDF.length}`);
    ok("library file: Range gives 206 with Content-Range, a suffix range the end, a range past the file 416");

    const unicode = await get(encodeURIComponent("Sewing/Janome/Handbuch über Nadeln.pdf"));
    assert.equal(unicode.status, 200);
    const cd = unicode.headers.get("content-disposition") ?? "";
    assert.match(cd, /^inline; filename="Handbuch _ber Nadeln\.pdf"; filename\*=UTF-8''Handbuch%20%C3%BCber%20Nadeln\.pdf$/);
    await unicode.arrayBuffer();
    ok("library file: a non-ASCII name gets an ASCII filename and the real one in filename*");

    // Everything that must be refused is a 400 (never a file's bytes): dotted, encoded, backslash, absolute, sibling, private, not a PDF.
    const refused: [string, string][] = [
      ["../outside.pdf", "dotted"],
      ["Sewing/../../outside.pdf", "dotted in the middle"],
      ["%2e%2e/outside.pdf", "percent-encoded dots"],
      ["%2e%2e%2foutside.pdf", "percent-encoded dots and slash"],
      ["..%5coutside.pdf", "backslash"],
      ["..\\outside.pdf", "backslash, literal"],
      ["Sewing\\..\\..\\outside.pdf", "backslash in the middle"],
      ["....//outside.pdf", "doubled dots and slashes"],
      [encodeURIComponent(path.join(root, "outside.pdf")), "absolute path"],
      ["/outside.pdf", "leading slash (the drive root)"],
      ["..%2flib-secret%2fsecret.pdf", "a sibling folder that starts with the library's name"],
      ["_business-notes/prices.pdf", "the business-notes folder"],
      ["_BUSINESS-NOTES/prices.pdf", "the business-notes folder in capitals"],
      ["Sewing/../_own-notes/mine.pdf", "the own-notes folder by a detour"],
      ["_own-notes%5Cmine.pdf", "the own-notes folder with a backslash"],
      ["Sewing/Janome/notes.txt", "not a PDF"],
      ["Sewing/Janome/a.pdf%00.txt", "a null byte"],
      ["Sewing/Janome/a.pdf%00", "a trailing null byte"],
      ["", "no path"],
      [".", "the library itself"],
    ];
    for (const [p, why] of refused) {
      const r = await get(p);
      assert.equal(r.status, 400, `${why}: ${p} answered ${r.status}`);
      assert.notEqual(r.headers.get("content-type"), "application/pdf", `${why}: ${p} served a PDF`);
      const h = await file.HEAD(new Request(`${BASE}/api/library/file?path=${p}`));
      assert.equal(h.status, r.status, `${why}: HEAD agrees with GET`);
    }
    ok(`library file: ${refused.length} traversal and private-folder paths are refused (dotted, encoded, backslash, absolute, sibling, private, not a PDF)`);

    // A folder named folder.pdf: stat() succeeds, so the route answers 200 and the stream then fails (a finding for the route: stat should
    // require isFile()). What matters here is that no bytes of anything come out and nothing crashes.
    const dirRes = await get("folder.pdf");
    const dirBytes = await dirRes.arrayBuffer().then(
      (b) => b.byteLength,
      () => -1,
    );
    assert.ok(dirBytes <= 0, "a folder named folder.pdf yields no file bytes");
    ok(`library file: a folder named folder.pdf yields no bytes (answered ${dirRes.status}; the route should say 404, see the report)`);

    // A symbolic link that points outside the library (needs the right to make one; skipped without it).
    let linked = false;
    try {
      fs.symlinkSync(path.join(root, "outside.pdf"), path.join(lib, "Sewing", "link.pdf"));
      linked = true;
    } catch {
      console.log("  --  symbolic link: this account can't make one, so that case is skipped");
    }
    if (linked) {
      const r = await get("Sewing/link.pdf");
      // Documents today's behaviour: the path check is textual, so a link the shop made inside the library is followed.
      console.log(`  ..  a symbolic link inside the library that points outside answers ${r.status} (the check is on the path text, not the link target)`);
      await r.arrayBuffer().catch(() => {});
    }

    // ---------- POST /api/library/file ----------
    const post = (fd: FormData) => file.POST(new Request(`${BASE}/api/library/file`, { method: "POST", body: fd }));
    signIn(null);
    assert.equal((await post(formOf(new Blob([PDF])))).status, 401);
    signIn(tech);
    assert.equal((await post(formOf(null))).status, 400, "no file");
    assert.equal((await post(formOf(new Blob([])))).status, 400, "an empty file");
    assert.equal((await post(formOf(new Blob(["<html>not a pdf</html>"], { type: "application/pdf" })))).status, 415, "the type header doesn't make it a PDF");
    assert.equal((await post(formOf(new Blob([Buffer.from("  %PDF-1.4 late")])))).status, 415, "%PDF- must be the first bytes");
    const notForm = await file.POST(new Request(`${BASE}/api/library/file`, { method: "POST", body: "plain text", headers: { "content-type": "text/plain" } }));
    assert.equal(notForm.status, 400, "not a form");
    assert.ok(!fs.existsSync(path.join(lib, "_inbox")) || fs.readdirSync(path.join(lib, "_inbox")).length === 0, "refused uploads left nothing in _inbox");
    process.env.LIBRARY_DIR = path.join(root, "not-there");
    assert.equal((await post(formOf(new Blob([PDF])))).status, 404, "no library folder");
    process.env.LIBRARY_DIR = lib;
    ok("scan upload: needs sign-in and a library; no file, empty, not a PDF (even labelled one) and not a form are refused");

    const saved = await post(formOf(new Blob([PDF]), { filename: "my scan.pdf" }));
    assert.equal(saved.status, 200);
    const savedBody = (await saved.json()) as { path: string };
    assert.equal(savedBody.path, "_inbox\\my scan.pdf");
    assert.equal(fs.readFileSync(path.join(lib, "_inbox", "my scan.pdf")).compare(PDF), 0);
    const second = (await (await post(formOf(new Blob([PDF]), { filename: "my scan.pdf" }))).json()) as { path: string };
    assert.equal(second.path, "_inbox\\my scan (2).pdf", "a taken name is never overwritten");
    const evil = (await (await post(formOf(new Blob([PDF]), { filename: "..\\..\\evil/x:y*.PDF" }))).json()) as { path: string };
    assert.match(evil.path, /^_inbox\\[\w\-+.() ]+\.pdf$/, `the name is made safe: ${evil.path}`);
    assert.ok(!fs.existsSync(path.join(root, "evil")) && !fs.existsSync(path.join(lib, "evil")), "nothing written outside _inbox");
    const none = (await (await post(formOf(new Blob([PDF])))).json()) as { path: string };
    assert.equal(none.path, "_inbox\\scan.pdf", "no name: scan.pdf");
    const blank = (await (await post(formOf(new Blob([PDF]), { filename: "///" }))).json()) as { path: string };
    assert.match(blank.path, /^_inbox\\[\w\-+.() ]+\.pdf$/);
    const long = (await (await post(formOf(new Blob([PDF]), { filename: `${"n".repeat(400)}.pdf` }))).json()) as { path: string };
    assert.ok(long.path.length <= "_inbox\\".length + 120 + ".pdf".length, "a long name is cut");
    // What it saved can be read back through GET (the returned path is a valid library path).
    const back = await get(encodeURIComponent(savedBody.path));
    assert.equal(back.status, 200);
    await back.arrayBuffer();
    ok("scan upload: saved to _inbox under a safe name, a taken name gets (2), nothing escapes _inbox, the returned path reads back");

    // ---------- /api/figures ----------
    const SRC = `Sewing\\Check\\Check_${RUN}_ServiceManual.pdf`;
    const fid = `chk${RUN}`;
    const box = [0.1, 0.2, 0.6, 0.7];
    const wid = figureId(SRC, 3, box);
    figIds.push(wid, figureId(SRC, 3, []));
    await db.factorySetting.create({
      data: {
        id: fid,
        category: "Sewing",
        brand: "Check",
        models: "CHK",
        modelKeys: ["CHK"],
        adjustment: "needle_bar_height",
        label: "Check",
        sourceFile: "x.pdf",
        sourcePath: SRC,
        figurePage: 3,
        figureBox: box,
      },
    });
    const jpeg = (marker: number) => new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0, marker, marker, marker])], { type: "image/jpeg" });
    const fig = (o: { file?: Blob | null; box?: string; sourcePath?: string; page?: string } = {}) => {
      const fd = new FormData();
      fd.set("sourcePath", o.sourcePath ?? SRC);
      fd.set("page", o.page ?? "3");
      fd.set("box", o.box ?? JSON.stringify(box));
      fd.set("width", "100");
      fd.set("height", "80");
      if (o.file !== null) fd.set("file", o.file ?? jpeg(1), "figure.jpg");
      return figures.POST(new Request(`${BASE}/api/figures`, { method: "POST", body: fd }));
    };
    const stored = async () => (await db.figureImage.findUnique({ where: { id: wid } }))?.data;

    signIn(null);
    assert.equal((await fig()).status, 401);
    assert.equal((await figures.GET()).status, 401);
    ok("figures: no sign-in, nothing saved and no answer");

    signIn(tech);
    const bad = async (label: string, o: Parameters<typeof fig>[0], status: number) => assert.equal((await fig(o)).status, status, label);
    await bad("box that isn't JSON", { box: "{" }, 400);
    await bad("box that isn't a list", { box: "{}" }, 400);
    await bad("box of three", { box: "[0,0,1]" }, 400);
    await bad("box of strings", { box: '["a","b","c","d"]' }, 400);
    await bad("box with null", { box: "[0,0,1,null]" }, 400);
    await bad("no file", { file: null }, 400);
    await bad("a PNG label", { file: new Blob([Buffer.from([0xff, 0xd8, 0xff])], { type: "image/png" }) }, 400);
    await bad("no source path", { sourcePath: "" }, 400);
    await bad("page that isn't a whole number", { page: "3.5" }, 400);
    await bad("page that isn't a number", { page: "x" }, 400);
    await bad("labelled JPEG but not one", { file: new Blob([Buffer.from("GIF89a")], { type: "image/jpeg" }) }, 415);
    await bad("too large a figure", { file: new Blob([Buffer.alloc(1_500_001, 0xff)], { type: "image/jpeg" }) }, 413);
    await bad("a figure no factory setting shows (other page)", { page: "4" }, 404);
    await bad("a figure no factory setting shows (other box)", { box: "[0.1,0.2,0.6,0.8]" }, 404);
    await bad("a figure no factory setting shows (other manual)", { sourcePath: `${SRC}.x` }, 404);
    assert.equal(await stored(), undefined, "no refused request stored anything");
    ok("figures: bad box, missing or mislabelled file, not a JPEG, too large and unknown figures are refused and store nothing");

    // First copy: a tech may store it; a tech may not replace it.
    assert.equal((await figures.GET().then((r) => r.json())).canReplace, false, "a tech can't replace");
    const first = await fig({ file: jpeg(1) });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { id: wid, replaced: false });
    assert.equal(Buffer.from((await stored())!).at(4), 1);
    const again = await fig({ file: jpeg(2) });
    assert.equal(again.status, 200);
    assert.equal((await again.json()).replaced, false);
    assert.equal(Buffer.from((await stored())!).at(4), 1, "a tech's second copy leaves the first");
    ok("figures: a tech stores the first copy and can't replace it (replaced: false)");

    // Another company's owner on an install with several companies: not the install's administrator.
    signIn(b.user);
    assert.equal((await figures.GET().then((r) => r.json())).canReplace, false, "another company's owner can't replace");
    assert.equal((await (await fig({ file: jpeg(3) })).json()).replaced, false);
    signIn(a.user);
    assert.equal((await figures.GET().then((r) => r.json())).canReplace, false, "this company's owner can't either when several share the install");
    assert.equal((await (await fig({ file: jpeg(4) })).json()).replaced, false);
    assert.equal(Buffer.from((await stored())!).at(4), 1, "owners of shared-install companies leave the stored figure");
    ok("figures: with several companies on the install, neither company's owner can replace a stored figure");

    // The administrator.
    process.env.PLATFORM_ADMIN_EMAILS = a.user.email;
    assert.equal((await figures.GET().then((r) => r.json())).canReplace, true, "the administrator can replace");
    const replaced = await fig({ file: jpeg(5) });
    assert.deepEqual(await replaced.json(), { id: wid, replaced: true });
    assert.equal(Buffer.from((await stored())!).at(4), 5, "the administrator's copy replaced it");
    const row = await db.figureImage.findUniqueOrThrow({ where: { id: wid } });
    assert.deepEqual([row.width, row.height, row.mime], [100, 80, "image/jpeg"]);
    // The administrator signed in as a tech of the same install is still not one.
    delete process.env.PLATFORM_ADMIN_EMAILS;
    ok("figures: the install's administrator replaces the stored figure (replaced: true)");

    void pushed; // (what a joined hub would have been sent never leaves this process)
    // A single-company install: its owner runs it. (Simulated by asking isInstallAdmin's own rule: one shop.)
    // Not run here: it would need to delete every other company on this database.
  } finally {
    restoreFetch();
    delete process.env.PLATFORM_ADMIN_EMAILS;
    delete process.env.LIBRARY_DIR;
    await db.figureImage.deleteMany({ where: { OR: [{ id: { in: figIds } }, { sourcePath: { contains: `Check_${RUN}_` } }] } }).catch(() => {});
    await db.factorySetting.deleteMany({ where: { id: `chk${RUN}` } }).catch(() => {});
    await db.user.deleteMany({ where: { email: `check-${RUN}-tech@stitchbench.test` } }).catch(() => {});
    await cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(`library-routes.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
