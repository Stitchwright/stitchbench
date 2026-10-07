-- AlterEnum
ALTER TYPE "PartKind" ADD VALUE 'SOFTWARE';

-- AlterTable
ALTER TABLE "Part" ADD COLUMN     "licenseKind" TEXT,
ADD COLUMN     "licenseMonths" INTEGER,
ADD COLUMN     "noReturnText" TEXT;

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "softwareActivatedAtSale" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "SoftwareLicense" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "partId" TEXT,
    "description" TEXT NOT NULL,
    "saleId" TEXT,
    "saleLineId" TEXT,
    "customerId" TEXT,
    "machineId" TEXT,
    "code" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'ONCE',
    "startsOn" TIMESTAMP(3) NOT NULL,
    "renewsOn" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT,
    "renewNoticeFor" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SoftwareLicense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SoftwareCode" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "usedById" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SoftwareCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SoftwareLicense_shopId_status_renewsOn_idx" ON "SoftwareLicense"("shopId", "status", "renewsOn");

-- CreateIndex
CREATE INDEX "SoftwareLicense_shopId_customerId_idx" ON "SoftwareLicense"("shopId", "customerId");

-- CreateIndex
CREATE INDEX "SoftwareLicense_shopId_saleId_idx" ON "SoftwareLicense"("shopId", "saleId");

-- CreateIndex
CREATE INDEX "SoftwareCode_shopId_partId_usedById_idx" ON "SoftwareCode"("shopId", "partId", "usedById");

-- CreateIndex
CREATE UNIQUE INDEX "SoftwareCode_shopId_partId_code_key" ON "SoftwareCode"("shopId", "partId", "code");

-- AddForeignKey
ALTER TABLE "SoftwareLicense" ADD CONSTRAINT "SoftwareLicense_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SoftwareLicense" ADD CONSTRAINT "SoftwareLicense_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SoftwareLicense" ADD CONSTRAINT "SoftwareLicense_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SoftwareCode" ADD CONSTRAINT "SoftwareCode_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SoftwareCode" ADD CONSTRAINT "SoftwareCode_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE CASCADE ON UPDATE CASCADE;

