-- AlterTable
ALTER TABLE "SaleLine" ADD COLUMN     "taxNote" TEXT;

-- CreateTable
CREATE TABLE "TaxHoliday" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "preset" TEXT,
    "firstDay" TEXT NOT NULL,
    "lastDay" TEXT NOT NULL,
    "kinds" TEXT[],
    "maxUnitCents" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxHoliday_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaxHoliday_shopId_firstDay_idx" ON "TaxHoliday"("shopId", "firstDay");

-- AddForeignKey
ALTER TABLE "TaxHoliday" ADD CONSTRAINT "TaxHoliday_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

