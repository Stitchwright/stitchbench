-- AlterTable
ALTER TABLE "LibraryDoc" ADD COLUMN     "downloadedAt" TIMESTAMP(3),
ADD COLUMN     "linkId" TEXT,
ADD COLUMN     "sourceUrl" TEXT;

-- CreateTable
CREATE TABLE "ManualDownload" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "jobLabel" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "tries" INTEGER NOT NULL DEFAULT 0,
    "path" TEXT,
    "filed" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,

    CONSTRAINT "ManualDownload_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ManualDownload_shopId_jobId_idx" ON "ManualDownload"("shopId", "jobId");

-- CreateIndex
CREATE INDEX "ManualDownload_status_queuedAt_idx" ON "ManualDownload"("status", "queuedAt");

-- CreateIndex
CREATE INDEX "ManualDownload_linkId_idx" ON "ManualDownload"("linkId");

-- CreateIndex
CREATE INDEX "LibraryDoc_linkId_idx" ON "LibraryDoc"("linkId");

-- AddForeignKey
ALTER TABLE "ManualDownload" ADD CONSTRAINT "ManualDownload_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

