"use client";

// "This computer is at": the store this device works at (shop-features-round-2-design.md 7.1), at the top of the menu,
// shown only when the company has more than one store. Changing it takes effect at once (the page reloads its data).
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { pickStore } from "@/actions/stores";
import { runAction } from "@/components/action-form";

export function StoreSwitch({ stores, current }: { stores: { id: string; name: string }[]; current: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <div className="px-4 pb-2 side:px-0">
      <label htmlFor="store-switch" className="muted block text-xs">
        This computer is at
      </label>
      <select
        id="store-switch"
        className="select mt-1 text-sm font-semibold"
        value={current}
        disabled={pending}
        data-testid="store-switch"
        onChange={(e) => {
          const fd = new FormData();
          fd.set("locationId", e.target.value);
          start(async () => {
            const r = await runAction(() => pickStore(fd));
            if (r.error) toast.error(r.error);
            else {
              toast.success(r.note ?? "Store changed");
              router.refresh();
            }
          });
        }}
      >
        {stores.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </div>
  );
}
