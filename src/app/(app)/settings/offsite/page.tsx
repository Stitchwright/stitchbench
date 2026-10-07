import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { shopTimeZone } from "@/lib/shop-zone";
import { fmtWhen } from "@/lib/zoned";
import { fmtBytes } from "@/lib/offsite/format";
import { backUpNow, saveOffsiteBucket, saveOffsiteTarget, testOffsiteBucket, testOffsiteKey, turnOffsiteOff } from "@/actions/offsite";
import { ActionButton, ActionForm, Submit } from "@/components/action-form";
import { OffsiteKey } from "@/components/offsite-key";
import { PageHeader, Section } from "@/components/ui";

/** Settings -> Off-site backup (later-round-1-design.md section 1): off until the recovery key is made and typed back. Owners and admins only. */
export default async function OffsitePage() {
  const user = await requireUser();
  if (user.role === "TECH") notFound();
  const tz = await shopTimeZone(user.shopId);
  const [shop, s, last, lastGood, objects] = await Promise.all([
    db.shop.findUniqueOrThrow({ where: { id: user.shopId }, select: { name: true } }),
    db.offsiteSettings.findUnique({ where: { shopId: user.shopId } }),
    db.offsiteRun.findFirst({ where: { shopId: user.shopId }, orderBy: { startedAt: "desc" } }),
    db.offsiteRun.findFirst({ where: { shopId: user.shopId, status: "ok" }, orderBy: { startedAt: "desc" } }),
    db.offsiteObject.aggregate({ where: { shopId: user.shopId, goneAt: null }, _count: true, _sum: { size: true } }),
  ]);
  const on = Boolean(s?.on);
  // The address and keys name only (the secret stays sealed on the server).
  const bucket = s?.bucket && typeof s.bucket === "object" ? (s.bucket as { endpoint?: string; bucket?: string; region?: string; accessKeyId?: string }) : null;
  return (
    <div className="space-y-4">
      <PageHeader
        back={{ href: "/settings", label: "Settings" }}
        title="Off-site backup"
        sub="A copy of this company, locked with a key only you hold, kept away from this computer. If the computer is lost, the company can be restored from it."
      />
      <Section title={on ? "Backups are on" : "Backups are off"}>
        <dl className="num mb-3 grid max-w-xl grid-cols-2 gap-y-1 text-sm">
          <dt className="muted">Last good backup</dt>
          <dd className="text-right">{lastGood ? `${fmtWhen(lastGood.startedAt, tz)} (${fmtBytes(Number(lastGood.bytes))}${lastGood.photos ? `, ${lastGood.photos} new pictures` : ""})` : "none yet"}</dd>
          {last && last.status === "failed" && (
            <>
              <dt className="muted">Last try</dt>
              <dd className="text-right">{`failed ${fmtWhen(last.startedAt, tz)}: ${last.error ?? "unknown"}`}</dd>
            </>
          )}
          <dt className="muted">Kept off-site</dt>
          <dd className="text-right">
            {objects._count} files, {fmtBytes(objects._sum.size ?? 0)}
          </dd>
          <dt className="muted">Key checked</dt>
          <dd className="text-right">{s?.keyCheckedAt ? fmtWhen(s.keyCheckedAt, tz) : "not yet"}</dd>
        </dl>
        <div className="flex flex-wrap gap-2">
          {on && (
            <>
              <ActionButton action={backUpNow} className="btn btn-primary">
                Back up off-site now
              </ActionButton>
              <ActionButton action={turnOffsiteOff} className="btn" confirm="Switch off-site backups off? Backups already made stay where they are.">
                Switch backups off
              </ActionButton>
            </>
          )}
        </div>
        <p className="muted mt-2 text-xs">A backup runs every night after 2 am (and when the computer starts, if it missed one). The last 14 days, 8 Sundays and 12 months are kept.</p>
      </Section>

      <Section title="The recovery key">
        <OffsiteKey shopName={shop.name} shopId={user.shopId} hasKey={Boolean(s?.publicKey)} on={on} />
      </Section>

      <Section title="Where it goes">
        <ActionForm action={saveOffsiteTarget} success="Saved" className="grid-form">
          <div className="field">
            <label htmlFor="target" className="label">
              Keep the backups
            </label>
            <select id="target" name="target" className="select" defaultValue={s?.target === "folder" ? "folder" : s?.target === "bucket" ? "bucket" : "hub"}>
              <option value="hub">With StitchHub (arranged for you)</option>
              <option value="folder">In a folder (a USB disk, OneDrive or Dropbox folder)</option>
              <option value="bucket">In my own bucket (R2, B2, Wasabi, S3 or MinIO)</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="folderPath" className="label">
              Folder (only for the folder choice)
            </label>
            <input id="folderPath" name="folderPath" className="input" defaultValue={s?.folderPath ?? ""} placeholder="D:\Backups\StitchBench" />
          </div>
          <div className="sm:col-span-2">
            <Submit>Save</Submit>
          </div>
        </ActionForm>
      </Section>

      <Section title="Your own bucket">
        <p className="muted mb-2 text-sm">For a bucket you pay for yourself. The backups are locked before they leave, so the bucket&apos;s owner can&apos;t read them. The secret key is kept for this company only and isn&apos;t shown again.</p>
        <ActionForm action={saveOffsiteBucket} success="Saved" className="grid-form">
          <div className="field">
            <label htmlFor="endpoint" className="label">
              Address
            </label>
            <input id="endpoint" name="endpoint" className="input" defaultValue={bucket?.endpoint ?? ""} placeholder="https://s3.us-west-000.backblazeb2.com" />
          </div>
          <div className="field">
            <label htmlFor="bucket" className="label">
              Bucket name
            </label>
            <input id="bucket" name="bucket" className="input" defaultValue={bucket?.bucket ?? ""} />
          </div>
          <div className="field">
            <label htmlFor="region" className="label">
              Region (R2: auto)
            </label>
            <input id="region" name="region" className="input" defaultValue={bucket?.region ?? "auto"} />
          </div>
          <div className="field">
            <label htmlFor="accessKeyId" className="label">
              Access key
            </label>
            <input id="accessKeyId" name="accessKeyId" className="input mono" defaultValue={bucket?.accessKeyId ?? ""} autoComplete="off" />
          </div>
          <div className="field">
            <label htmlFor="secret" className="label">
              Secret key {bucket ? "(blank keeps the saved one)" : ""}
            </label>
            <input id="secret" name="secret" type="password" className="input mono" autoComplete="new-password" />
          </div>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Submit>Save the bucket</Submit>
            {bucket && (
              <ActionButton action={testOffsiteBucket} className="btn">
                Test the bucket
              </ActionButton>
            )}
          </div>
        </ActionForm>
      </Section>

      {on && (
        <Section title="Test my recovery key">
          <p className="muted mb-2 text-sm">Type the key from the sheet. The program opens the newest backup with it and shows how many rows are inside, beside how many are in the program now. Do this twice a year.</p>
          <ActionForm action={testOffsiteKey} className="flex flex-wrap items-end gap-2">
            <div className="field">
              <label htmlFor="test-key" className="label">
                Recovery key
              </label>
              <input id="test-key" name="key" className="input mono" autoComplete="off" spellCheck={false} placeholder="ABCD-EFGH-..." />
            </div>
            <Submit>Test the key</Submit>
          </ActionForm>
        </Section>
      )}
    </div>
  );
}
