import type { PublicKeys } from "./license";

// The public halves of StitchBench's signing keys (never the private halves). scripts/license/keygen.ts prints each line.
// any: keys the owner signs and sells (pasted in Settings -> Modules).
// hosted: the hosted app's Companies switch; counts only on a server holding that hosting key (never on the Windows program).
// hub: StitchHub's own key (hub-accounts-billing-design.md 3.5): the keys it issues for the program itself ("base") arrive with the
//      sync and count like pasted keys; they never count as the hosted Companies switch. The private half is HUB_LICENSE_KEY on the hub.
// dev: development and local test builds only (modules-design.md section 3.3); scripts/license/dev-key.json is in the repo on purpose.
// Never delete a line: retire it (section 3.3 of modules-design.md). A deleted kid turns its keys into "needs a newer version".
export const LICENSE_PUBLIC_KEYS: PublicKeys = {
  dev1: { x: "cYT5uNzPQTauwyFFy7M2yz1CXVlrD9NCLJEL3ozeiiA", scope: "dev" },
  // k1: { x: "...", scope: "any" },     <- the owner adds this line from `npm run license:keygen -- --kid k1` before the first release
  // h1: { x: "...", scope: "hosted" },  <- and this one from `npm run license:keygen -- --kid h1 --hosted`
  // hub1: { x: "...", scope: "hub" },   <- and this one from `npm run license:keygen -- --kid hub1 --hub` (its private half is the hub's HUB_LICENSE_KEY)
};
