-- AlterTable
ALTER TABLE "User" ADD COLUMN     "foundryId" INTEGER;

-- CreateTable
CREATE TABLE "FoundrySession" (
    "idHash" TEXT NOT NULL,
    "foundryId" INTEGER NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FoundrySession_pkey" PRIMARY KEY ("idHash")
);

-- CreateIndex
CREATE INDEX "FoundrySession_foundryId_idx" ON "FoundrySession"("foundryId");

-- CreateIndex
CREATE INDEX "User_foundryId_idx" ON "User"("foundryId");

-- CreateIndex
CREATE UNIQUE INDEX "User_shopId_foundryId_key" ON "User"("shopId", "foundryId");
