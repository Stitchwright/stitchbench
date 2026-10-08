-- AlterTable
ALTER TABLE "Location" ADD COLUMN     "approveFails" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "approveLockedUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "joinCodeById" TEXT,
ADD COLUMN     "joinCodeHash" TEXT,
ADD COLUMN     "joinCodeUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "TaxHoliday" ADD COLUMN     "locationIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "approveCodeOld" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "approveFails" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "approveLockedUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "SlipReceipt" (
    "shopId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "words" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SlipReceipt_pkey" PRIMARY KEY ("shopId","key")
);


-- Codes set before codes were 6 numbers: asked to change (accepted until then)
UPDATE "User" SET "approveCodeOld" = true WHERE "approveCode" IS NOT NULL;
