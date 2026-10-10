"use client";

import { Toaster, toast } from "sonner";
import { UndoBar } from "@/components/undo-bar";

// An error stays until it is closed (ease-of-use.md 8): someone reading slowly, or looking at the customer, must not
// miss what went wrong. Every toast.error in the program goes through here, so the default is set once; a call that
// passes its own duration still wins.
const showError = toast.error;
toast.error = ((message, data) => showError(message, { duration: Infinity, ...data })) as typeof toast.error;

/**
 * The program's pop-up notes: at the top in the middle, where the eye is (the register's totals and payment sit on
 * the right), 16px text, kept 8 seconds, each with a close button. The Undo bar (after a removal) sits at the bottom.
 */
export function AppToaster() {
  return (
    <>
      <Toaster position="top-center" richColors closeButton duration={8000} toastOptions={{ style: { fontSize: "1rem" } }} />
      <UndoBar />
    </>
  );
}
