-- AlterTable
ALTER TABLE "SaleLine" ADD COLUMN     "promotionId" TEXT;

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "taxIncludedOn" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Promotion" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "firstDay" TEXT NOT NULL,
    "lastDay" TEXT NOT NULL,
    "scope" JSONB NOT NULL DEFAULT '{}',
    "effect" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Promotion_shopId_firstDay_idx" ON "Promotion"("shopId", "firstDay");

-- AddForeignKey
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

