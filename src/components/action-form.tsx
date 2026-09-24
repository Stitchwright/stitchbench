"use client";

import { useRef, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { toast } from "sonner";
import type { ActionResult } from "@/lib/action";

type Action = (formData: FormData) => Promise<ActionResult>;

/** A form that runs a server action and shows its error (or a success note) as a toast. */
export function ActionForm({
  action,
  children,
  success,
  reset = false,
  className,
  id,
}: {
  action: Action;
  children: React.ReactNode;
  success?: string;
  reset?: boolean;
  className?: string;
  id?: string;
}) {
  const ref = useRef<HTMLFormElement>(null);
  return (
    <form
      id={id}
      ref={ref}
      className={className}
      action={async (fd) => {
        const r = await action(fd);
        if (r?.error) toast.error(r.error);
        else {
          if (success) toast.success(success);
          if (reset) ref.current?.reset();
        }
      }}
    >
      {children}
    </form>
  );
}

export function Submit({ children, className = "btn btn-primary" }: { children: React.ReactNode; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending}>
      {pending ? "Saving..." : children}
    </button>
  );
}

/** A button that calls a pre-bound server action (no form fields). */
export function ActionButton({
  action,
  children,
  className = "btn btn-sm",
  confirm,
  success,
  title,
}: {
  action: () => Promise<ActionResult>;
  children: React.ReactNode;
  className?: string;
  confirm?: string;
  success?: string;
  title?: string;
}) {
  const [pending, start] = useTransition();
  const armed = useRef(false);
  return (
    <button
      type="button"
      title={title}
      className={className}
      disabled={pending}
      onClick={(e) => {
        // Two-tap confirm instead of window.confirm: first tap arms, second runs.
        if (confirm && !armed.current) {
          armed.current = true;
          const btn = e.currentTarget;
          const old = btn.textContent;
          btn.textContent = confirm;
          setTimeout(() => {
            armed.current = false;
            if (btn.isConnected) btn.textContent = old;
          }, 3000);
          return;
        }
        armed.current = false;
        start(async () => {
          const r = await action();
          if (r?.error) toast.error(r.error);
          else if (success) toast.success(success);
        });
      }}
    >
      {children}
    </button>
  );
}
