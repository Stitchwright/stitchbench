// Quilt appraisals (shop-features-round-2-design.md 9.8): what a value is for. Pure.
export const PURPOSES = { insurance: "Insurance replacement value", fair: "Fair market value", donation: "Donation value" } as const;
export type Purpose = keyof typeof PURPOSES;
