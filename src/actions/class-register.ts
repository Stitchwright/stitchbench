"use server";
/* eslint-disable @typescript-eslint/no-unused-vars -- foundation stub: the classes package fills in the bodies */

// Classes at the register: the open classes with seats, and signing a customer up from the register (design 12.3).
// Foundation stub (owner: classes).
import { requireUser } from "@/lib/session";
import type { BookingDue } from "@/lib/booking-types";

export async function openClassSeats(): Promise<{ id: string; title: string; firstAt: Date | null; seatsLeft: number; feeCents: number }[]> {
  await requireUser();
  return [];
}

export async function enrollAtRegister(classId: string, fd: FormData): Promise<BookingDue | { error: string }> {
  await requireUser();
  return { error: "Coming in this update." };
}
