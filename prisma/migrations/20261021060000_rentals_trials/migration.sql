-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "trialDays" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "StockUnit" ADD COLUMN     "trialUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "UnitLoan" ADD COLUMN     "ownPct" INTEGER,
ADD COLUMN     "ownUntil" TEXT,
ADD COLUMN     "rateCents" INTEGER,
ADD COLUMN     "ratePer" TEXT;

