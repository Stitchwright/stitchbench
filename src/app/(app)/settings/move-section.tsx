// Settings → Company → "Move this company" (company-move-design.md section 8): what the file holds (everything), what is
// left out, which modules will need a key, the freeze; then the confirm, and once confirmed the progress of the download
// (from the CompanyMove row, so it survives a reload), the Download button and Cancel. Owner only; shown by settings/page.tsx.
import type { CurrentUser } from "@/lib/session";
import { fmtDateTime } from "@/lib/format";
import { moveView } from "@/lib/move/export";
import { LEFT_OUT_WORDS } from "@/lib/move/format";
import { Section } from "@/components/ui";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { cancelCompanyMove, startCompanyMove } from "@/actions/move";

const mb = (n: number) => (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0);

export async function MoveSection({ user, timeZone }: { user: CurrentUser; timeZone: string }) {
  if (user.role !== "OWNER") return null;
  const v = await moveView(user, user.shopId);
  const { shop, move } = v;
  if (shop.movedOutAt) {
    return (
      <Section title="Move this company" id="move">
        <p className="text-sm">
          This company moved{shop.movedTo ? ` to ${shop.movedTo}` : ""} on {fmtDateTime(shop.movedOutAt, timeZone)}. This copy is read-only.
        </p>
      </Section>
    );
  }
  if (!shop.movingAt) {
    return (
      <Section title="Move this company" id="move">
        <div className="space-y-3 text-sm">
          <p>
            Take this company to another StitchBench or StitchShop: the shop PC, your own server, or the hosted service. The move file holds everything this company holds, with the same ids, so
            partner links, license keys and the StitchHub connection carry on: customers, machines, tickets, photos, parts and stock, sales, messages and consent records, classes, appointments,
            shifts, online orders, partner records and every login (with its password hash). <strong>Keep the file as you would a backup:</strong> whoever has it has the shop.
          </p>
          <p>
            Left out, to enter again on the new side: {LEFT_OUT_WORDS.join("; ")}. The manual library is the PC&apos;s folder, not in the file. Marketplace listings and orders come back from the hub
            after the move.
          </p>
          {v.needKeys.length > 0 && (
            <p className="tone-wait card card-pad">
              {v.needKeys.join(" and ")} {v.needKeys.length === 1 ? "is" : "are"} switched on here by the hosted administrator. On the new install {v.needKeys.length === 1 ? "it" : "they"} need a
              license key: ask for one before you move.
            </p>
          )}
          <p>
            From the moment you confirm, this copy is <strong>read-only</strong>: everyone can still look things up, finish open work and take payments, but nothing new is written here, so nothing
            entered after the file was taken can be lost. Cancel the move at any time to carry on here. Once the company is running on the new install, this copy stays read-only; delete it after 30
            days.
          </p>
          <ActionForm action={startCompanyMove} className="space-y-3">
            <div className="field">
              <label htmlFor="move-to" className="label">
                Where is it going? (shown on the read-only notice here; optional)
              </label>
              <input id="move-to" name="to" className="input" maxLength={80} placeholder="the shop PC, the hosted StitchShop, our own server" />
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="agreed" className="check mt-0.5" required /> I understand the file holds everything this company holds, including every login&apos;s password hash, and that
              this copy becomes read-only now.
            </label>
            <Submit>Prepare the move file</Submit>
          </ActionForm>
        </div>
      </Section>
    );
  }
  const status = move?.status ?? "ready";
  const done = move?.rowsDone ?? 0;
  const total = move?.rowsTotal ?? 0;
  return (
    <Section title="Move this company" id="move">
      <div className="space-y-3 text-sm">
        <p className="card card-pad tone-bad">
          This company is moving{shop.movedTo ? ` to ${shop.movedTo}` : ""}; it is read-only here since {fmtDateTime(shop.movingAt, timeZone)}.
        </p>
        {move && (
          <p>
            {status === "ready" && "The move file is ready to download. It is made as you download it, from one snapshot of the database."}
            {status === "downloading" &&
              `Downloading: ${move.table ?? "finishing"}, ${done.toLocaleString()} of ${total.toLocaleString()} rows, ${mb(move.bytes)} MB so far. Reload this page for a newer figure.`}
            {status === "done" &&
              `Downloaded ${move.downloadedAt ? fmtDateTime(move.downloadedAt, timeZone) : ""}: ${done.toLocaleString()} rows, ${mb(move.bytes)} MB. Download it again if the file was lost.`}
            {status === "failed" && `${move.error ?? "The download stopped."} Download it again.`}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {move && (
            // A file download, not a page: a plain link.
            <a href={`/api/move/download/${move.id}`} className="btn btn-primary" download={v.fileName}>
              Download the move file
            </a>
          )}
          <ActionButton action={cancelCompanyMove} confirm="Tap again to cancel the move" className="btn" success="The move is cancelled; this copy is working again">
            Cancel the move
          </ActionButton>
        </div>
        <p className="muted">
          The file is {v.fileName}. It downloads only over https or on the program&apos;s own PC. Import it on the new install (its first run, or Companies on the hosted service), then delete this
          copy after 30 days.
        </p>
      </div>
    </Section>
  );
}
