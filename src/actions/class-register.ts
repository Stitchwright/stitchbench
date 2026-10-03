"use server";

// Classes at the register (scheduling-messaging-design.md 12.1 / 12.3): the open classes with seats, and signing a
// customer up from the register. The work is in src/lib/class-actions.ts.
import { revalidatePath } from "next/cache";
import { isUserError } from "@/lib/action";
import { requireBaseWritable } from "@/lib/base-gate";
import { assertId } from "@/lib/input";
import { requireUser } from "@/lib/session";
import type { BookingDue } from "@/lib/booking-types";
import { enrollAtRegisterAs, openClassSeatsFor } from "@/lib/class-actions";

/** OPEN classes not yet over, with seats left, soonest first (30 at most). [] without Scheduling. */
export async function openClassSeats(): Promise<{ id: string; title: string; firstAt: Date | null; seatsLeft: number; feeCents: number }[]> {
  const user = await requireUser();
  return openClassSeatsFor(user.shopId);
}

/** A sign-up from the register (never waitlisted there); the new seat comes back as the line to ring up. */
export async function enrollAtRegister(classId: string, fd: FormData): Promise<BookingDue | { error: string }> {
  try {
    const user = await requireUser();
    await requireBaseWritable(user); // a new seat is new work: refused while the program is read-only
    const id = assertId(classId);
    const due = await enrollAtRegisterAs(user, id, fd);
    revalidatePath(`/classes/${id}`);
    revalidatePath("/classes");
    return due;
  } catch (err) {
    if (isUserError(err)) return { error: err.message };
    throw err;
  }
}
