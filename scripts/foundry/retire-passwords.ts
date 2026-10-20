// Retire the local passwords of every login that has a Foundry Account linked (docs/plan.md FA-5). Needs FOUNDRY_SIGNIN=only.
// A dry run unless --apply is given. From a Railway service: railway run npm run foundry:retire-passwords [-- --apply]
import "dotenv/config";
import { db } from "@/lib/db";
import { retirePasswords } from "@/lib/foundry/retire";
import { isUserError } from "@/lib/user-error";

const apply = process.argv.includes("--apply");

retirePasswords({ apply })
  .then((r) => {
    console.log(`${r.linked} login(s) have a Foundry Account linked.`);
    console.log(apply ? `Retired the local password of ${r.retired}.` : "Dry run: nothing changed. Add --apply to retire their local passwords.");
    if (r.waiting.length) {
      console.log(`\n${r.waiting.length} active login(s) have no Foundry Account yet. They keep their passwords but can't sign in until they link (Settings → People → Make a sign-in link, or Companies → Reset link):`);
      for (const w of r.waiting) console.log(`  ${w.email}  (${w.role}, ${w.company})`);
    }
  })
  .catch((e) => {
    console.error(isUserError(e) ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
