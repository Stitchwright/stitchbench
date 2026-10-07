// The common merge fields (COMMON_FIELDS in templates.ts) for a message to one customer. Pure.

/** Her name and first name, the shop's name and phone. */
export function customerVars(name: string, shop: { name: string; phone: string | null }): Record<string, string> {
  const n = name.trim();
  return { first_name: n.split(/\s+/)[0] ?? "", name: n, shop_name: shop.name, shop_phone: shop.phone ?? "" };
}
