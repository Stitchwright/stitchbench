/* eslint-disable @typescript-eslint/no-unused-vars -- foundation stub: the owning package fills in the bodies */
import "server-only";
// Central vac installs: SITE tickets (modules-design.md section 10.d). Foundation stub; central-vac-installs fills it in.
import { UserError } from "@/lib/action";
import type { CurrentUser } from "@/lib/session";

export const INSTALL_CHECKLIST: string[] = [];

export type SiteJob = { ticketId: string; number: number; address: string; startsAt: Date | null; endsAt: Date | null; status: string };

/** Installs with a start inside [from, to) for the Scheduling calendar; applies the vac gate itself. */
export async function siteJobsBetween(_shopId: string, _from: Date, _to: Date): Promise<SiteJob[]> {
  return [];
}

export async function listInstalls(_shopId: string, _tab?: string | null): Promise<SiteJob[]> {
  return [];
}

export async function createSiteJob(_user: CurrentUser, _fd: FormData): Promise<never> {
  throw new UserError("Coming in this update.");
}
