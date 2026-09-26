"use client";

import { createContext, useContext, useEffect, useRef, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { toast } from "sonner";
import type { ActionResult } from "@/lib/action";

type Action = (formData: FormData) => Promise<ActionResult>;

const Pending = createContext(false);

/**
 * A form that runs a server action and shows its error (or a success note) as a toast. It submits itself rather than
 * through React's form action, which clears every field after each submit: here what was typed stays when the server
 * says no, and the form is cleared only after a success when `reset` is set.
 */
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
  const [pending, start] = useTransition();
  return (
    <Pending.Provider value={pending}>
      <form
        id={id}
        ref={ref}
        className={className}
        onSubmit={(e) => {
          e.preventDefault();
          if (pending) return;
          const form = e.currentTarget;
          const fd = new FormData(form, (e.nativeEvent as SubmitEvent).submitter);
          start(async () => {
            const r = await action(fd);
            if (r?.error) toast.error(r.error);
            else {
              if (success) toast.success(success);
              if (reset) form.reset();
            }
          });
        }}
      >
        {children}
      </form>
    </Pending.Provider>
  );
}

export function Submit({ children, className = "btn btn-primary" }: { children: React.ReactNode; className?: string }) {
  const { pending: formPending } = useFormStatus();
  const pending = useContext(Pending) || formPending;
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
  // Two-tap confirm instead of window.confirm: the first tap arms it (for 3 seconds), the second runs it.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      type="button"
      title={title}
      className={className}
      disabled={pending}
      onClick={() => {
        if (confirm && !armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        start(async () => {
          const r = await action();
          if (r?.error) toast.error(r.error);
          else if (success) toast.success(success);
        });
      }}
    >
      {armed && confirm ? confirm : children}
    </button>
  );
}
