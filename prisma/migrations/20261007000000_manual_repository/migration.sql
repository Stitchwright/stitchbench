-- AlterTable
ALTER TABLE "HubState" ADD COLUMN     "repoCursor" TEXT,
ADD COLUMN     "repoProbeAt" TIMESTAMP(3),
ADD COLUMN     "repoUploads" TEXT;

-- AlterTable
ALTER TABLE "LibraryDoc" ADD COLUMN     "sha1" TEXT,
ADD COLUMN     "sha256" TEXT,
ADD COLUMN     "withdrawnAt" TIMESTAMP(3),
ADD COLUMN     "withdrawnWhy" TEXT;

-- AlterTable
ALTER TABLE "ManualDownload" ADD COLUMN     "retryAfter" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ManualLink" ADD COLUMN     "language" TEXT,
ADD COLUMN     "origin" TEXT NOT NULL DEFAULT 'link',
ADD COLUMN     "pages" INTEGER,
ADD COLUMN     "sha1" TEXT,
ADD COLUMN     "sha256" TEXT,
ADD COLUMN     "sizeBytes" INTEGER,
ADD COLUMN     "year" INTEGER;

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "techsOfferManuals" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ManualOffer" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "userId" TEXT,
    "byName" TEXT NOT NULL,
    "path" TEXT,
    "fileName" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "models" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "year" INTEGER,
    "language" TEXT NOT NULL DEFAULT 'English',
    "title" TEXT,
    "statementVersion" TEXT NOT NULL,
    "statementAt" TIMESTAMP(3) NOT NULL,
    "hubUploadId" TEXT,
    "hubManualId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'SENDING',
    "reason" TEXT,
    "tries" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManualOffer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ManualOffer_shopId_createdAt_idx" ON "ManualOffer"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "ManualOffer_hubUploadId_idx" ON "ManualOffer"("hubUploadId");

-- CreateIndex
CREATE INDEX "LibraryDoc_sha256_idx" ON "LibraryDoc"("sha256");

-- CreateIndex
CREATE INDEX "LibraryDoc_sha1_idx" ON "LibraryDoc"("sha1");

-- AddForeignKey
ALTER TABLE "ManualOffer" ADD CONSTRAINT "ManualOffer_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

