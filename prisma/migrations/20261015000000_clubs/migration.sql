-- CreateEnum
CREATE TYPE "ClubKind" AS ENUM ('FAT_QUARTER', 'FABRIC', 'BOM', 'OTHER');

-- CreateEnum
CREATE TYPE "ClubMemberStatus" AS ENUM ('ACTIVE', 'PAUSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ClubFulfil" AS ENUM ('PICKUP', 'SHIP');

-- CreateEnum
CREATE TYPE "ClubBilling" AS ENUM ('STRIPE', 'PAY_AT_PICKUP');

-- CreateTable
CREATE TABLE "Club" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "ClubKind" NOT NULL DEFAULT 'FAT_QUARTER',
    "monthlyCents" INTEGER NOT NULL,
    "fulfil" "ClubFulfil" NOT NULL DEFAULT 'PICKUP',
    "billDay" INTEGER,
    "seriesId" TEXT,
    "note" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Club_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClubMember" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "status" "ClubMemberStatus" NOT NULL DEFAULT 'ACTIVE',
    "fulfil" "ClubFulfil" NOT NULL DEFAULT 'PICKUP',
    "billing" "ClubBilling" NOT NULL DEFAULT 'PAY_AT_PICKUP',
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "paidMonth" TEXT,
    "lastPaidAt" TIMESTAMP(3),
    "payFailedAt" TIMESTAMP(3),
    "note" TEXT,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pausedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "ClubMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClubMonth" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "what" TEXT NOT NULL,
    "kitId" TEXT,

    CONSTRAINT "ClubMonth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClubPick" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "doneAt" TIMESTAMP(3),
    "doneFulfil" "ClubFulfil",
    "tracking" TEXT,

    CONSTRAINT "ClubPick_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Club_shopId_idx" ON "Club"("shopId");

-- CreateIndex
CREATE INDEX "ClubMember_shopId_clubId_status_idx" ON "ClubMember"("shopId", "clubId", "status");

-- CreateIndex
CREATE INDEX "ClubMember_shopId_stripeSubscriptionId_idx" ON "ClubMember"("shopId", "stripeSubscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "ClubMember_clubId_customerId_key" ON "ClubMember"("clubId", "customerId");

-- CreateIndex
CREATE INDEX "ClubMonth_shopId_idx" ON "ClubMonth"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "ClubMonth_clubId_month_key" ON "ClubMonth"("clubId", "month");

-- CreateIndex
CREATE INDEX "ClubPick_shopId_clubId_month_idx" ON "ClubPick"("shopId", "clubId", "month");

-- CreateIndex
CREATE UNIQUE INDEX "ClubPick_memberId_month_key" ON "ClubPick"("memberId", "month");

-- AddForeignKey
ALTER TABLE "Club" ADD CONSTRAINT "Club_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Club" ADD CONSTRAINT "Club_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "KitSeries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubMember" ADD CONSTRAINT "ClubMember_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubMember" ADD CONSTRAINT "ClubMember_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubMember" ADD CONSTRAINT "ClubMember_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubMonth" ADD CONSTRAINT "ClubMonth_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubMonth" ADD CONSTRAINT "ClubMonth_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubPick" ADD CONSTRAINT "ClubPick_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubPick" ADD CONSTRAINT "ClubPick_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubPick" ADD CONSTRAINT "ClubPick_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "ClubMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

