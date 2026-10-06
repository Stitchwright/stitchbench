-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "fabAbcAPct" INTEGER NOT NULL DEFAULT 80,
ADD COLUMN     "fabAbcBPct" INTEGER NOT NULL DEFAULT 95,
ADD COLUMN     "fabBlendDays" INTEGER NOT NULL DEFAULT 42,
ADD COLUMN     "fabClearanceDays" INTEGER NOT NULL DEFAULT 180,
ADD COLUMN     "fabCutCostCents" INTEGER NOT NULL DEFAULT 50,
ADD COLUMN     "fabEarlyDays" INTEGER NOT NULL DEFAULT 21,
ADD COLUMN     "fabFloorPct" INTEGER NOT NULL DEFAULT 105,
ADD COLUMN     "fabGmroiGood" DOUBLE PRECISION NOT NULL DEFAULT 3,
ADD COLUMN     "fabGmroiReview" DOUBLE PRECISION NOT NULL DEFAULT 1.5,
ADD COLUMN     "fabMarkdownDays" INTEGER NOT NULL DEFAULT 120,
ADD COLUMN     "fabMarkdownSoldPct" INTEGER NOT NULL DEFAULT 60,
ADD COLUMN     "fabStep1Pct" INTEGER NOT NULL DEFAULT 20,
ADD COLUMN     "fabStep2Pct" INTEGER NOT NULL DEFAULT 35,
ADD COLUMN     "fabStep3Pct" INTEGER NOT NULL DEFAULT 50,
ADD COLUMN     "fabUnratedDays" INTEGER NOT NULL DEFAULT 42,
ADD COLUMN     "fabVelocityWeeks" INTEGER NOT NULL DEFAULT 12,
ADD COLUMN     "fabWatchDays" INTEGER NOT NULL DEFAULT 90,
ADD COLUMN     "fabWatchWeeks" INTEGER NOT NULL DEFAULT 26;

-- CreateTable
CREATE TABLE "FabricMarkdown" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "step" INTEGER NOT NULL,
    "pct" INTEGER NOT NULL,
    "regularCents" INTEGER NOT NULL,
    "oldCents" INTEGER NOT NULL,
    "newCents" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "userId" TEXT,
    "userName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undoneAt" TIMESTAMP(3),

    CONSTRAINT "FabricMarkdown_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FabricMarkdown_shopId_partId_createdAt_idx" ON "FabricMarkdown"("shopId", "partId", "createdAt");

-- AddForeignKey
ALTER TABLE "FabricMarkdown" ADD CONSTRAINT "FabricMarkdown_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FabricMarkdown" ADD CONSTRAINT "FabricMarkdown_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE CASCADE ON UPDATE CASCADE;
