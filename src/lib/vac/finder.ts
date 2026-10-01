/* eslint-disable @typescript-eslint/no-unused-vars -- foundation stub: the owning package fills in the bodies */
import "server-only";
// The bag / belt / filter finder (modules-design.md section 10.b). Foundation stub; the vac-finder package fills it in.

export type Supply = { id: string; name: string; category: string; partId: string | null };

export async function suppliesFor(_a: { shopId: string; brand: string; model: string; bagType?: string | null; q?: string | null }): Promise<{ supplies: Supply[]; truncated: boolean }> {
  return { supplies: [], truncated: false };
}
