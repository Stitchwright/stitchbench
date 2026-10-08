-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "birthDay" INTEGER,
ADD COLUMN     "birthMonth" INTEGER,
ADD COLUMN     "birthdayUsedYear" INTEGER;

-- AlterTable
ALTER TABLE "Part" ADD COLUMN     "breakMinQty" DOUBLE PRECISION,
ADD COLUMN     "breakPriceCents" INTEGER;

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "birthdayOffer" JSONB;

-- CreateTable
CREATE TABLE "YardBreak" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "minYards" DOUBLE PRECISION NOT NULL,
    "pctOff" INTEGER NOT NULL,
    "kinds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "YardBreak_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "YardBreak_shopId_idx" ON "YardBreak"("shopId");

-- AddForeignKey
ALTER TABLE "YardBreak" ADD CONSTRAINT "YardBreak_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

