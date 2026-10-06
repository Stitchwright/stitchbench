-- CreateEnum
CREATE TYPE "LongarmStatus" AS ENUM ('RECEIVED', 'ON_FRAME', 'READY', 'COLLECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LongarmPricing" AS ENUM ('PER_SQIN', 'FLAT');

-- CreateEnum
CREATE TYPE "LongarmDesign" AS ENUM ('PANTOGRAPH', 'CUSTOM');

-- AlterTable
ALTER TABLE "AppointmentType" ADD COLUMN     "hourlyCents" INTEGER,
ADD COLUMN     "needsCert" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "longarmCertifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "nextLongarmNumber" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "LongarmOrder" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "customerId" TEXT,
    "name" TEXT NOT NULL,
    "status" "LongarmStatus" NOT NULL DEFAULT 'RECEIVED',
    "widthIn" INTEGER NOT NULL,
    "lengthIn" INTEGER NOT NULL,
    "pricing" "LongarmPricing" NOT NULL DEFAULT 'PER_SQIN',
    "rateTenthCents" INTEGER NOT NULL DEFAULT 0,
    "flatCents" INTEGER NOT NULL DEFAULT 0,
    "design" "LongarmDesign" NOT NULL DEFAULT 'PANTOGRAPH',
    "designName" TEXT,
    "thread" TEXT,
    "threadCents" INTEGER NOT NULL DEFAULT 0,
    "batting" TEXT,
    "battingCents" INTEGER NOT NULL DEFAULT 0,
    "extraCents" INTEGER NOT NULL DEFAULT 0,
    "extraNote" TEXT,
    "quiltCents" INTEGER NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "taxable" BOOLEAN NOT NULL DEFAULT true,
    "dueAt" TIMESTAMP(3),
    "note" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "onFrameAt" TIMESTAMP(3),
    "readyAt" TIMESTAMP(3),
    "collectedAt" TIMESTAMP(3),
    "saleId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LongarmOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LongarmPhoto" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "caption" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LongarmPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LongarmOrder_shopId_status_dueAt_idx" ON "LongarmOrder"("shopId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "LongarmOrder_shopId_customerId_idx" ON "LongarmOrder"("shopId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "LongarmOrder_shopId_number_key" ON "LongarmOrder"("shopId", "number");

-- CreateIndex
CREATE INDEX "LongarmPhoto_shopId_orderId_idx" ON "LongarmPhoto"("shopId", "orderId");

-- AddForeignKey
ALTER TABLE "LongarmOrder" ADD CONSTRAINT "LongarmOrder_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LongarmOrder" ADD CONSTRAINT "LongarmOrder_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LongarmPhoto" ADD CONSTRAINT "LongarmPhoto_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LongarmPhoto" ADD CONSTRAINT "LongarmPhoto_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "LongarmOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

