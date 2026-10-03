// Makes a StitchBench signing key pair (modules-design.md section 4, "keygen") and prints the line for src/lib/license-keys.ts.
//   npm run license:keygen -- --kid k1              the owner's key -> ~/.stitchbench/license-k1.pem, encrypted with a passphrase
//   npm run license:keygen -- --kid h1 --hosted     the hosting key for the Companies switch (plain: it goes into Railway's variables)
//   npm run license:keygen -- --kid hub1 --hub      StitchHub's key for the program itself ("base"; plain: it goes into the hub's Railway variables)
//   npm run license:keygen -- --dev                 the development key -> scripts/license/dev-key.json (committed on purpose)
//   --out <file>                                    where to write it (never inside the repo, except --dev)
// The passphrase comes from STITCH_LICENSE_PASSPHRASE, or is asked for twice with nothing echoed.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expandHome, fail, insideDir, parseArgs, readPassphrase, repoRoot, stitchDir, str } from "./cli";

function usage() {
  console.log(
    [
      "usage: npm run license:keygen -- --kid k1 [--out ~/.stitchbench/license-k1.pem]   the owner's signing key (encrypted)",
      "       npm run license:keygen -- --kid h1 --hosted [--out <file>]                  the hosting key for the Companies switch",
      "       npm run license:keygen -- --kid hub1 --hub [--out <file>]                   StitchHub's key for the program itself (HUB_LICENSE_KEY)",
      "       npm run license:keygen -- --dev [--out scripts/license/dev-key.json]       the development key (committed)",
    ].join("\n"),
  );
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2), ["kid", "hosted", "hub", "dev", "out", "help"], ["hosted", "hub", "dev", "help"]);
  if (flags.help) return usage();
  const dev = flags.dev === true;
  const hosted = flags.hosted === true;
  const hub = flags.hub === true;
  if ([dev, hosted, hub].filter(Boolean).length > 1) fail("Pick one of --dev, --hosted and --hub.", 2);
  const kid = str(flags.kid) ?? (dev ? "dev1" : undefined);
  if (!kid) {
    usage();
    fail("Say which key this is: --kid k1 (or --kid h1 --hosted, --kid hub1 --hub, or --dev).", 2);
  }
  if (!/^[a-z][a-z0-9]{0,15}$/.test(kid)) fail("A kid is a short lower-case word, like k1, h2 or dev1.", 2);

  const root = repoRoot();
  const out = path.resolve(expandHome(str(flags.out) ?? (dev ? path.join(root, "scripts", "license", "dev-key.json") : path.join(stitchDir(), `license-${kid}.pem`))));
  // The private half must never be committed by accident; the development key is the one exception (it is public by design).
  if (!dev && insideDir(out, root)) fail(`${out} is inside the repo. Keep the private key outside the repo, e.g. ~/.stitchbench/`);
  if (fs.existsSync(out)) fail(`${out} already exists: keep it, or pick another --out`);

  let passphrase: string | undefined;
  if (!dev && !hosted && !hub) {
    passphrase = await readPassphrase("Passphrase for the new key (10 or more characters): ");
    if (passphrase.length < 10) fail("The passphrase needs at least 10 characters. Nothing was written.");
    if (!process.env.STITCH_LICENSE_PASSPHRASE) {
      const again = await readPassphrase("Type it again: ");
      if (again !== passphrase) fail("The two passphrases don't match. Nothing was written.");
    }
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const x = (publicKey.export({ format: "jwk" }) as { x: string }).x;
  const pem = privateKey.export(passphrase ? { type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase } : { type: "pkcs8", format: "pem" }) as string;
  const scope = dev ? "dev" : hosted ? "hosted" : hub ? "hub" : "any";

  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (dev) {
    const json = {
      kid,
      scope,
      note: "Development signing key: committed on purpose. Keys it signs count only in next dev, check scripts and a local test build (modules-design.md section 3.3).",
      x,
      privateKeyPem: pem,
    };
    fs.writeFileSync(out, JSON.stringify(json, null, 2) + "\n", { flag: "wx" });
  } else {
    // 0600 is a no-op on Windows; the passphrase is what protects the owner's key there.
    fs.writeFileSync(out, pem, { flag: "wx", mode: 0o600 });
    try {
      fs.chmodSync(out, 0o600);
    } catch {
      // Windows: nothing to do.
    }
  }

  console.log(`Wrote ${out}`);
  console.log("");
  console.log("Add this line to LICENSE_PUBLIC_KEYS in src/lib/license-keys.ts, then release:");
  console.log("");
  console.log(`  ${kid}: { x: "${x}", scope: "${scope}" },`);
  console.log("");
  if (hosted) {
    console.log("Railway variables for the hosted app (the value is the key file, base64):");
    console.log("");
    console.log(`  LICENSE_HOSTED_KID=${kid}`);
    console.log(`  LICENSE_HOSTED_KEY=${Buffer.from(pem, "utf8").toString("base64")}`);
    console.log("");
    console.log("Once they are set you can delete the .pem file: the hosting key lives in Railway's variables. Anyone with that value can switch modules on in the hosted app.");
  } else if (hub) {
    console.log("Railway variable for the hub (project stitchhub; the value is the key file, base64). The hub signs every shop's program key with it:");
    console.log("");
    console.log(`  HUB_LICENSE_KID=${kid}`);
    console.log(`  HUB_LICENSE_KEY=${Buffer.from(pem, "utf8").toString("base64")}`);
    console.log("");
    console.log('Release both programs with the line above before the hub starts signing: an older program shows a hub key as "needs a newer version". Anyone with the value can license any shop.');
  } else if (dev) {
    console.log("Commit the file: development keys count only in next dev, check scripts and a local test build.");
  } else {
    console.log("Back up the .pem file, and keep the passphrase somewhere else (a password manager). Anyone with both can make keys.");
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
