-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "hopOn" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ShopHop" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "hubHopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startsOn" TEXT,
    "endsOn" TEXT,
    "rule" TEXT NOT NULL DEFAULT 'all',
    "shopsCount" INTEGER NOT NULL DEFAULT 1,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "status" TEXT NOT NULL DEFAULT 'JOINED',
    "slug" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopHop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HopStampLocal" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "hopId" TEXT NOT NULL,
    "passportRef" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "byUserId" TEXT,
    "sentAt" TIMESTAMP(3),
    "stampNo" INTEGER,
    "stampsOf" INTEGER,
    "complete" BOOLEAN NOT NULL DEFAULT false,
    "shopperName" TEXT,
    "shopperEmail" TEXT,
    "shopperPhone" TEXT,
    "error" TEXT,

    CONSTRAINT "HopStampLocal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopHop_shopId_hubHopId_key" ON "ShopHop"("shopId", "hubHopId");

-- CreateIndex
CREATE INDEX "HopStampLocal_shopId_at_idx" ON "HopStampLocal"("shopId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "HopStampLocal_hopId_passportRef_key" ON "HopStampLocal"("hopId", "passportRef");

-- AddForeignKey
ALTER TABLE "ShopHop" ADD CONSTRAINT "ShopHop_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HopStampLocal" ADD CONSTRAINT "HopStampLocal_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HopStampLocal" ADD CONSTRAINT "HopStampLocal_hopId_fkey" FOREIGN KEY ("hopId") REFERENCES "ShopHop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

