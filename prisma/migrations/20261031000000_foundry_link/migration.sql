-- CreateTable
CREATE TABLE "FoundryLink" (
    "shopId" TEXT NOT NULL,
    "foundryId" INTEGER NOT NULL,
    "email" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'ok',
    "creditsLeft" INTEGER,
    "checkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FoundryLink_pkey" PRIMARY KEY ("shopId")
);

-- CreateIndex
CREATE INDEX "FoundryLink_foundryId_idx" ON "FoundryLink"("foundryId");

-- AddForeignKey
ALTER TABLE "FoundryLink" ADD CONSTRAINT "FoundryLink_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
