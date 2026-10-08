"use server";

// Google and Facebook feeds (shop-features-round-2-design.md 4.1, 4.2): Settings, Online shop, Google and Facebook.
// Bodies in src/lib/shop/feeds.ts.
import { revalidatePath } from "next/cache";
import { safe } from "@/lib/action";
import { str } from "@/lib/format";
import { requireUser } from "@/lib/session";
import { newFeedLinksFor, turnFeedsOffFor, turnFeedsOnFor } from "@/lib/shop/feeds";

export const turnFeedsOn = safe(async function turnFeedsOn(formData: FormData) {
  const user = await requireUser();
  await turnFeedsOnFor(user, str(formData.get("storeCode")));
  revalidatePath("/settings/shop/feeds");
});

export const turnFeedsOff = safe(async function turnFeedsOff() {
  const user = await requireUser();
  await turnFeedsOffFor(user);
  revalidatePath("/settings/shop/feeds");
});

export const newFeedLinks = safe(async function newFeedLinks() {
  const user = await requireUser();
  await newFeedLinksFor(user);
  revalidatePath("/settings/shop/feeds");
});
