"use client";
// "Answered" on a customer's question, with Undo instead of a confirmation.
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { markQuestion } from "@/actions/customer-answers";
import { runAction } from "@/components/action-form";

export function QuestionDone({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      className="btn btn-sm"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await runAction(() => markQuestion(id, true));
          if (r?.error) return void toast.error(r.error);
          router.refresh();
          toast.success("Done.", {
            duration: 15_000,
            action: {
              label: "Undo",
              onClick: async () => {
                await runAction(() => markQuestion(id, false));
                router.refresh();
              },
            },
          });
        })
      }
    >
      Answered
    </button>
  );
}
