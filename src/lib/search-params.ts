// A parameter repeated in the address (?q=a&q=b) reaches a page as an array, and .trim() or a Prisma filter on it
// fails with a server error. Pages take the first value of each.
export function firstValues<T extends object>(sp: T): T {
  return Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])) as T;
}
