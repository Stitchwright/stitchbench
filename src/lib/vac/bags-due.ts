/* eslint-disable @typescript-eslint/no-unused-vars -- foundation stub: the owning package fills in the bodies */
import "server-only";
// "Bags due" (modules-design.md section 10.c'). Foundation stub; the vac-bags-due package fills it in. runBagsDue is
// called by the scheduling design's scheduler and does nothing in this build (automatic sending was cut).

export type BagsDueRow = { machineId: string; customerId: string | null; dueOn: string };

export async function bagsDue(_shopId: string): Promise<BagsDueRow[]> {
  return [];
}

export async function bagsDueCount(_shopId: string): Promise<number> {
  return 0;
}

export async function runBagsDue(_now: Date, _shopIds?: string[]): Promise<void> {}

/** Whether a queued bags-due message should still go out; null = no opinion. */
export function bagsDueStillWanted(_row: { kind: string; shopId: string }): boolean | null {
  return null;
}
