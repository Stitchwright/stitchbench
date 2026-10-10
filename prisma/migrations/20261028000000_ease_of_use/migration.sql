
-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "gettingStartedHiddenAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "whatsNewSeen" TEXT;

-- CreateTable
CREATE TABLE "HelpReply" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "hubId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "reply" TEXT NOT NULL,
    "repliedAt" TIMESTAMP(3) NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HelpReply_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HelpReply_shopId_repliedAt_idx" ON "HelpReply"("shopId", "repliedAt");

-- CreateIndex
CREATE UNIQUE INDEX "HelpReply_shopId_hubId_key" ON "HelpReply"("shopId", "hubId");

-- AddForeignKey
ALTER TABLE "HelpReply" ADD CONSTRAINT "HelpReply_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

