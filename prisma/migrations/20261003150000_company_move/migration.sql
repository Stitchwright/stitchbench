-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "movedFrom" TEXT,
ADD COLUMN     "movedInAt" TIMESTAMP(3),
ADD COLUMN     "movedOutAt" TIMESTAMP(3),
ADD COLUMN     "movedTo" TEXT,
ADD COLUMN     "movingAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CompanyMove" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "table" TEXT,
    "rowsDone" INTEGER NOT NULL DEFAULT 0,
    "rowsTotal" INTEGER NOT NULL DEFAULT 0,
    "bytes" BIGINT NOT NULL DEFAULT 0,
    "filePath" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "downloadedAt" TIMESTAMP(3),
    "byUserId" TEXT,

    CONSTRAINT "CompanyMove_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CompanyMove_shopId_startedAt_idx" ON "CompanyMove"("shopId", "startedAt");

-- AddForeignKey
ALTER TABLE "CompanyMove" ADD CONSTRAINT "CompanyMove_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

