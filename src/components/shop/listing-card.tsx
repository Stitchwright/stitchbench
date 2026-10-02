// The part page's "Online shop" card (online-and-parts-design.md section 3): sell it online or not, the words the
// customer sees, up to four photos. Owners and admins list; everyone may edit the words and photos.
import Link from "next/link";
import { db } from "@/lib/db";
import { MAX_PHOTOS } from "@/lib/shop/online-shop";
import { addPhoto, removePhoto, saveListing } from "@/actions/online-shop";
import { ActionForm, Submit } from "@/components/action-form";
import { Section } from "@/components/ui";

export async function ListingCard({
  part,
  admin,
  shopOn,
}: {
  part: { id: string; online: boolean; onlineTitle: string | null; onlineText: string | null; priceCents: number | null; consignLinkId: string | null; description: string };
  admin: boolean;
  shopOn: boolean;
}) {
  const photos = await db.partPhoto.findMany({ where: { partId: part.id }, orderBy: { sortOrder: "asc" }, select: { id: true } });
  return (
    <Section title="Online shop">
      {!shopOn && (
        <p className="muted mb-3 text-xs">
          The online shop is off.{" "}
          {admin && (
            <Link href="/settings/shop" className="link">
              Settings, Online shop
            </Link>
          )}
        </p>
      )}
      {part.consignLinkId ? (
        <p className="muted text-sm">A partner&apos;s consigned stock isn&apos;t sold online.</p>
      ) : (
        <>
          <ActionForm action={saveListing.bind(null, part.id)} success="Saved" className="space-y-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="hidden" name="online" value="off" />
              <input type="checkbox" name="online" value="on" defaultChecked={part.online} disabled={!admin} className="check" /> Sell online
              {part.priceCents == null && <span className="muted text-xs">(needs a price)</span>}
            </label>
            <div className="field">
              <label htmlFor="ol-title" className="label">
                Title customers see (blank: the description)
              </label>
              <input id="ol-title" name="onlineTitle" defaultValue={part.onlineTitle ?? ""} className="input" maxLength={120} placeholder={part.description} />
            </div>
            <div className="field">
              <label htmlFor="ol-text" className="label">
                Text for customers (optional)
              </label>
              <textarea id="ol-text" name="onlineText" defaultValue={part.onlineText ?? ""} rows={3} maxLength={2000} className="input" />
            </div>
            <Submit className="btn btn-sm">Save listing</Submit>
          </ActionForm>
          <div className="mt-4 space-y-2">
            <div className="label">
              Photos ({photos.length} of {MAX_PHOTOS})
            </div>
            {photos.length > 0 && (
              <ul className="flex flex-wrap gap-2">
                {photos.map((p) => (
                  <li key={p.id} className="space-y-1">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/api/shop/photo/${p.id}?v=${p.id}`} alt="" className="h-20 w-20 rounded border border-line object-cover" />
                    <ActionForm action={removePhoto.bind(null, part.id, p.id)} success="Photo removed">
                      <Submit className="btn btn-sm">Remove</Submit>
                    </ActionForm>
                  </li>
                ))}
              </ul>
            )}
            {photos.length < MAX_PHOTOS && (
              <ActionForm action={addPhoto.bind(null, part.id)} success="Photo added" reset className="flex items-center gap-2">
                <input type="file" name="photo" accept="image/jpeg,image/png,image/webp" aria-label="Photo" className="input text-sm" required />
                <Submit className="btn btn-sm">Add photo</Submit>
              </ActionForm>
            )}
            {photos.length > 0 && !part.online && <p className="muted text-xs">Photos show on the shop page once the item is listed.</p>}
          </div>
        </>
      )}
    </Section>
  );
}
