-- CreateTable
CREATE TABLE "PartnerSeen" (
    "shopId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartnerSeen_pkey" PRIMARY KEY ("shopId","key")
);

