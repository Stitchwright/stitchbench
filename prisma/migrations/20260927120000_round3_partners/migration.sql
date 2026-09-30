-- A payment the partner says it made counts once this shop confirms it. Payments recorded before this version count
-- as they did.
ALTER TABLE "Settlement" ADD COLUMN "confirmedAt" TIMESTAMP(3);
UPDATE "Settlement" SET "confirmedAt" = "paidAt";
