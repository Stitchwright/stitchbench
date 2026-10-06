-- AlterTable
ALTER TABLE "PartnerLink" ADD COLUMN     "lastUnsignedAt" TIMESTAMP(3),
ADD COLUMN     "partnerKey" TEXT,
ADD COLUMN     "partnerKeyAt" TIMESTAMP(3),
ADD COLUMN     "partnerKeyHow" TEXT,
ADD COLUMN     "sigSeqIn" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "sigSeqOut" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "unsignedIn" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PartnerOutbox" ADD COLUMN     "sig" JSONB;

-- CreateTable
CREATE TABLE "PartnerKey" (
    "shopId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "privateSealed" TEXT,
    "invites" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartnerKey_pkey" PRIMARY KEY ("shopId")
);

-- AddForeignKey
ALTER TABLE "PartnerKey" ADD CONSTRAINT "PartnerKey_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

