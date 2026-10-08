-- AlterTable
ALTER TABLE "Shop" ALTER COLUMN "loanerDays" SET DEFAULT 14;


-- The column is new in 20261021050000_loaners: shops still on its first default take the new one.
UPDATE "Shop" SET "loanerDays" = 14 WHERE "loanerDays" = 2;
