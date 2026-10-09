-- AlterTable
ALTER TABLE "MessagingSettings" ADD COLUMN     "smsRegisteredAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "HelpOutbox" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "picture" BYTEA,
    "fingerprint" TEXT,
    "day" TEXT,
    "count" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "tries" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,

    CONSTRAINT "HelpOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HelpOutbox_sentAt_createdAt_idx" ON "HelpOutbox"("sentAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "HelpOutbox_shopId_kind_fingerprint_day_key" ON "HelpOutbox"("shopId", "kind", "fingerprint", "day");

-- AddForeignKey
ALTER TABLE "HelpOutbox" ADD CONSTRAINT "HelpOutbox_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

