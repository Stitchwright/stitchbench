import type { PublicKeys } from "./license";

// The public halves of StitchBench's signing keys (never the private halves).
// any: keys the owner signed and sold before 1.8 (pasted in Settings -> Modules); no such kid was ever compiled in.
// hosted: the hosted app's Companies switch before 1.8; counted only on a server holding that hosting key (none did).
// hub: StitchHub's own key (hub-accounts-billing-design.md 3.5): the keys it issues (the Assistant's, and the program's
//      own) arrive with the sync and count like pasted keys. It also signs the password-reset grants
//      (src/lib/hub-reset-grants.ts). The private half is HUB_LICENSE_KEY on the hub.
// dev: development and local test builds only (modules-design.md section 3.3); scripts/license/dev-key.json is in the repo on purpose.
// Never delete a line: retire it (section 3.3 of modules-design.md). A deleted kid turns its keys into "needs a newer version".
export const LICENSE_PUBLIC_KEYS: PublicKeys = {
  dev1: { x: "cYT5uNzPQTauwyFFy7M2yz1CXVlrD9NCLJEL3ozeiiA", scope: "dev" },
  hub1: { x: "sMNkyagIZm4nvvAn5cvP7bDebcBUcxmhcubWS4mzas0", scope: "hub" },
};
