"use client";

import { createContext, useContext, useEffect, useRef, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { unstable_rethrow } from "next/navigation";
import { toast } from "sonner";
import type { ActionResult } from "@/lib/action";
import { showUndo } from "@/components/undo-bar";

type Action = (formData: FormData) => Promise<ActionResult>;

const Pending = createContext(false);

/**
 * Calls a server action from a click or a submit. A failure the server didn't explain (it errored, or the connection
 * dropped while the shop PC restarted) comes back as an error to show: thrown inside the transition it would replace
 * the whole page, and lose whatever was typed.
 */
export async function runAction(call: () => Promise<ActionResult>): Promise<ActionResult> {
  try {
    return await call();
  } catch (e) {
    unstable_rethrow(e); // an action that redirects still goes on to its page
    console.error(e);
    return { error: "Couldn't save: check the connection and try again." };
  }
}

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
            const r = await runAction(() => action(fd));
            if (r?.error) toast.error(r.error);
            else {
              if (r?.warn) toast.warning(r.warn, { duration: 8000 });
              else if (r?.note) toast.success(r.note, { duration: 8000 });
              else if (success) toast.success(success);
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
  undo,
}: {
  action: () => Promise<ActionResult>;
  children: React.ReactNode;
  className?: string;
  confirm?: string;
  success?: string;
  title?: string;
  /** The restore action for a removal that returns an undo offer: the Undo bar calls it with the offer's token. */
  undo?: (token: string) => Promise<ActionResult>;
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
          const r = await runAction(action);
          if (r?.error) toast.error(r.error);
          else if (r?.undo && undo) {
            const token = r.undo.token;
            showUndo(r.undo.text, () => runAction(() => undo(token)));
          } else if (r?.warn) toast.warning(r.warn, { duration: 8000 });
          else if (r?.note) toast.success(r.note, { duration: 8000 });
          else if (success) toast.success(success);
        });
      }}
    >
      {armed && confirm ? confirm : children}
    </button>
  );
}
