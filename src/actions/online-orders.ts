"use server";

// Taking orders from MakerFoundry (docs/plans/makerfoundry-orders-plan.md package 2). Bodies in src/lib/shop-orders/online.ts. Each is
// refused while the program is read-only (safe()).
import { revalidatePath } from "next/cache";
import { noted, safe } from "@/lib/action";
import { requireUser } from "@/lib/session";
import { simulateCustomerFor, simulateOrderFor } from "@/lib/shop-orders/demo";
import { publishCatalogFor, removeOfferFor, removeProductFor, saveOfferFor, saveProductFor, saveShippingFor, setOnlineOrdersFor } from "@/lib/shop-orders/online";

const refresh = (id?: string) => {
  revalidatePath("/decorating", "layout");
  if (id) revalidatePath(`/decorating/${id}`);
};

export const setOnlineOrders = safe(async function setOnlineOrders(formData: FormData) {
  const user = await requireUser();
  const text = await setOnlineOrdersFor(user, formData);
  refresh();
  return noted(text);
});

export const saveOnlineShipping = safe(async function saveOnlineShipping(formData: FormData) {
  const user = await requireUser();
  const text = await saveShippingFor(user, formData);
  refresh();
  return noted(text);
});

export const saveOnlineProduct = safe(async function saveOnlineProduct(formData: FormData) {
  const user = await requireUser();
  const text = await saveProductFor(user, formData);
  refresh();
  return noted(text);
});

export const removeOnlineProduct = safe(async function removeOnlineProduct(id: string) {
  const user = await requireUser();
  const text = await removeProductFor(user, id);
  refresh();
  return noted(text);
});

export const saveOnlineOffer = safe(async function saveOnlineOffer(formData: FormData) {
  const user = await requireUser();
  const text = await saveOfferFor(user, formData);
  refresh();
  return noted(text);
});

export const removeOnlineOffer = safe(async function removeOnlineOffer(id: string) {
  const user = await requireUser();
  const text = await removeOfferFor(user, id);
  refresh();
  return noted(text);
});

export const publishOnlineCatalog = safe(async function publishOnlineCatalog() {
  const user = await requireUser();
  const text = await publishCatalogFor(user.shopId);
  refresh();
  return noted(text);
});

/** Demo only: a customer places an order from this shop's own garments and prices (the same code takes it as a real one). */
export const simulateOnlineOrder = safe(async function simulateOnlineOrder(kind: string) {
  const user = await requireUser();
  const text = await simulateOrderFor(user, kind === "ship" ? "ship" : "pickup");
  refresh();
  return noted(text);
});

/** Demo only: the customer answers the proof, or cancels. */
export const simulateOnlineCustomer = safe(async function simulateOnlineCustomer(id: string, what: string) {
  const user = await requireUser();
  const text = await simulateCustomerFor(user, id, what === "approved" ? "approved" : what === "cancel" ? "cancel" : "changes");
  refresh(id);
  return noted(text);
});
