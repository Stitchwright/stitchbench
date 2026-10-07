"use client";
// Remove a care tip, with Undo instead of a confirmation (shop-features-round-2-design.md section 0).
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { removeCareTip, restoreCareTip } from "@/actions/care-tips";
import { runAction } from "@/components/action-form";

export function CareTipRemove({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      className="btn btn-sm"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await runAction(() => removeCareTip(id));
          if (r?.error) return void toast.error(r.error);
          const undo = r?.shown ? (JSON.parse(r.shown) as { kind: string; text: string; sortOrder: number }) : null;
          router.refresh();
          toast.success("Done.", {
            duration: 15_000,
            action: undo
              ? {
                  label: "Undo",
                  onClick: async () => {
                    const u = await runAction(() => restoreCareTip(undo));
                    if (u?.error) toast.error(u.error);
                    router.refresh();
                  },
                }
              : undefined,
          });
        })
      }
    >
      Remove
    </button>
  );
}
