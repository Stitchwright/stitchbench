-- AlterTable
ALTER TABLE "License" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'pasted';

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "hubAccountEmail" TEXT,
ADD COLUMN     "hubAccountVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hubResetOptIn" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hubStanding" TEXT,
ADD COLUMN     "hubStandingAt" TIMESTAMP(3),
ADD COLUMN     "hubStandingNote" TEXT,
ADD COLUMN     "hubStandingUntil" TEXT,
ADD COLUMN     "termsVersion" TEXT;

-- CreateIndex
CREATE INDEX "License_shopId_source_idx" ON "License"("shopId", "source");

