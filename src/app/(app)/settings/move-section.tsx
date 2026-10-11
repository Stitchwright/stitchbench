// Settings → Company → "Move this company" (company-move-design.md section 8): what the file holds (everything), what is
// left out, which modules will need a key, the freeze; then the confirm, and once confirmed the progress of the download
// (from the CompanyMove row, so it survives a reload), the Download button and Cancel. Package move-hub adds the hub's
// part: whether the file carries a StitchHub move token, "The move is done" when the hub can't say so, the moved notice
// on the old copy (with the day it may be deleted), and on a company that came here from a move file, how its hub step
// stands with "Re-point the hub". Owner only; shown by settings/page.tsx.
import type { CurrentUser } from "@/lib/session";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { moveView } from "@/lib/move/export";
import { deleteFrom, LEFT_OUT_WORDS } from "@/lib/move/format";
import { isDesktop } from "@/lib/modules";
import { Section } from "@/components/ui";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { cancelCompanyMove, confirmCompanyMoved, repointCompanyHub, startCompanyMove } from "@/actions/move";

const mb = (n: number) => (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0);

export async function MoveSection({ user, timeZone }: { user: CurrentUser; timeZone: string }) {
  if (user.role !== "OWNER") return null;
  const v = await moveView(user, user.shopId);
  const { shop, move } = v;
  if (shop.movedOutAt) {
    return (
      <Section title="Move this company" id="move">
        <div className="space-y-2 text-sm">
          <p>
            This company moved{shop.movedTo ? ` to ${shop.movedTo}` : ""} on {fmtDateTime(shop.movedOutAt, timeZone)}. This copy is read-only; delete it after{" "}
            {fmtDate(deleteFrom(shop.movedOutAt), timeZone)}.
          </p>
          <p className="muted">
            {isDesktop()
              ? "From then, remove it with the program's tray icon: Remove the moved company... (or uninstall the program if this PC has nothing else to keep). Nothing deletes it by itself."
              : "From then, the StitchBench administrator deletes it under Companies. Nothing deletes it by itself."}
          </p>
        </div>
      </Section>
    );
  }
  if (!shop.movingAt) {
    const mi = v.movedIn;
    return (
      <Section title="Move this company" id="move">
        <div className="space-y-3 text-sm">
          {mi && !mi.none && (
            <div className={`card card-pad ${mi.doneAt ? "" : "tone-wait"}`} data-testid="moved-in-hub">
              {mi.doneAt ? (
                <p>This company came here from a move file. StitchHub has it here since {fmtDateTime(mi.doneAt, timeZone)}: its partner links, listings and shared notes followed it.</p>
              ) : (
                <div className="space-y-2">
                  <p>This company came here from a move file. {mi.error ?? "StitchHub hasn't been told yet that it is here."}</p>
                  {mi.canRetry && (
                    <ActionButton action={repointCompanyHub.bind(null, shop.id)} className="btn btn-primary btn-sm" success="StitchHub has the company here now">
                      Re-point the hub
                    </ActionButton>
                  )}
                </div>
              )}
            </div>
          )}
          <p>
            Take this company to another StitchBench or StitchShop: the shop PC, your own server, or the hosted service. The move file holds everything this company holds, with the same ids, so
            partner links, the features you use and the StitchHub connection carry on: customers, machines, tickets, photos, parts and stock, sales, messages and consent records, classes, appointments,
            shifts, online orders, partner records and every login (with its password hash). <strong>Keep the file as you would a backup:</strong> whoever has it has the shop.
          </p>
          <p>
            Left out, to enter again on the new side: {LEFT_OUT_WORDS.join("; ")}. The manual library is the PC&apos;s folder, not in the file. Marketplace listings and orders come back from the hub
            after the move.
          </p>
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
              <input type="checkbox" name="agreed" className="check mt-0.5" required />{" "}I understand the file holds everything this company holds, including every login&apos;s password hash, and that
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
        {v.hub.onHub &&
          (v.hub.hasToken ? (
            <p>
              StitchHub: the file carries a move token (one use, 14 days). The new install redeems it when it imports the file, and the company&apos;s partner links, marketplace listings and shared
              notes follow it; partner shops see nothing change. This copy hears it at its next sync.
            </p>
          ) : (
            <p className="tone-wait card card-pad">
              StitchHub couldn&apos;t give a move token{v.hub.error ? ` (${v.hub.error})` : ""}. Download the file again once the hub answers to get one. Without it, the StitchHub admin moves the
              company on the hub by hand after the import (Moves → Move this shop).
            </p>
          ))}
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
        {status === "done" && (
          <div className="flex flex-wrap items-center gap-2">
            <ActionButton action={confirmCompanyMoved} confirm="Tap again: the company is running on the new install" className="btn" success="This copy now says where the company went">
              The move is done
            </ActionButton>
            <span className="muted">
              {v.hub.onHub
                ? "Only when the hub can't say so itself (the file had no move token): this copy hears it from the hub at its next sync otherwise."
                : "This install isn't on a hub, so it can't hear that the import worked: say so here once the company runs on the new install."}{" "}
              This copy then shows where the company went, and can be deleted after 30 days.
            </span>
          </div>
        )}
      </div>
    </Section>
  );
}
