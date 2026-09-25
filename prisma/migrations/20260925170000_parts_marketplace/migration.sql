-- CreateEnum
CREATE TYPE "PartKind" AS ENUM ('PART', 'ACCESSORY', 'SUPPLY');

-- AlterTable
ALTER TABLE "HubState" ADD COLUMN     "orderCursor" TEXT;

-- AlterTable
ALTER TABLE "Part" ADD COLUMN     "altNumbers" TEXT[],
ADD COLUMN     "kind" "PartKind" NOT NULL DEFAULT 'PART',
ADD COLUMN     "numberKeys" TEXT[];

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "payInstructions" TEXT;

-- CreateTable
CREATE TABLE "PartSource" (
    "id" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "url" TEXT,
    "priceCents" INTEGER,
    "note" TEXT,
    "preferred" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "XPart" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'PART',
    "category" TEXT,
    "specs" TEXT,
    "notes" TEXT,
    "numbers" JSONB NOT NULL,
    "numberKeys" TEXT[],
    "fits" JSONB NOT NULL,
    "fitKeys" TEXT[],
    "sources" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "XPart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Listing" (
    "id" TEXT NOT NULL,
    "shopName" TEXT NOT NULL,
    "mine" BOOLEAN NOT NULL DEFAULT false,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'PART',
    "condition" TEXT NOT NULL DEFAULT 'NEW',
    "brand" TEXT,
    "partNumber" TEXT,
    "numberKey" TEXT,
    "xpartId" TEXT,
    "fits" TEXT,
    "priceCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "qty" INTEGER NOT NULL,
    "shippingCents" INTEGER,
    "shippingNote" TEXT,
    "shipsFrom" TEXT,
    "status" TEXT NOT NULL,
    "photoIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Listing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListingPhoto" (
    "id" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "data" BYTEA NOT NULL,

    CONSTRAINT "ListingPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketOrder" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PartSource_partId_idx" ON "PartSource"("partId");

-- CreateIndex
CREATE INDEX "XPart_numberKeys_idx" ON "XPart" USING GIN ("numberKeys");

-- CreateIndex
CREATE INDEX "XPart_fitKeys_idx" ON "XPart" USING GIN ("fitKeys");

-- CreateIndex
CREATE INDEX "Listing_status_idx" ON "Listing"("status");

-- CreateIndex
CREATE INDEX "Listing_numberKey_idx" ON "Listing"("numberKey");

-- CreateIndex
CREATE INDEX "MarketOrder_role_status_idx" ON "MarketOrder"("role", "status");

-- CreateIndex
CREATE INDEX "Part_numberKeys_idx" ON "Part" USING GIN ("numberKeys");

-- AddForeignKey
ALTER TABLE "PartSource" ADD CONSTRAINT "PartSource_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE CASCADE ON UPDATE CASCADE;

