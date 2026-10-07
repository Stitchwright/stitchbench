-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "appraisalFeeCents" INTEGER NOT NULL DEFAULT 7500,
ADD COLUMN     "appraiserCredential" TEXT,
ADD COLUMN     "appraiserName" TEXT,
ADD COLUMN     "nextAppraisalNumber" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "Appraisal" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "customerId" TEXT,
    "name" TEXT NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "valueCents" INTEGER NOT NULL DEFAULT 0,
    "purpose" TEXT NOT NULL DEFAULT 'insurance',
    "appraiser" TEXT,
    "credential" TEXT,
    "feeCents" INTEGER NOT NULL DEFAULT 0,
    "saleId" TEXT,
    "issuedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Appraisal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppraisalPhoto" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "appraisalId" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppraisalPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Appraisal_shopId_customerId_idx" ON "Appraisal"("shopId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Appraisal_shopId_number_key" ON "Appraisal"("shopId", "number");

-- CreateIndex
CREATE INDEX "AppraisalPhoto_appraisalId_idx" ON "AppraisalPhoto"("appraisalId");

-- AddForeignKey
ALTER TABLE "Appraisal" ADD CONSTRAINT "Appraisal_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppraisalPhoto" ADD CONSTRAINT "AppraisalPhoto_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppraisalPhoto" ADD CONSTRAINT "AppraisalPhoto_appraisalId_fkey" FOREIGN KEY ("appraisalId") REFERENCES "Appraisal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

