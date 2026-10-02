-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'counter';

-- AlterTable
ALTER TABLE "AppointmentType" ADD COLUMN     "online" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Enrollment" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'counter';

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "bookingDaysAhead" INTEGER NOT NULL DEFAULT 60,
ADD COLUMN     "bookingLeadHours" INTEGER NOT NULL DEFAULT 24,
ADD COLUMN     "bookingOn" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "bookingSlug" TEXT,
ADD COLUMN     "bookingWelcome" TEXT;

-- AlterTable
ALTER TABLE "ShopClass" ADD COLUMN     "online" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "BookingLink" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "appointmentId" TEXT,
    "enrollmentId" TEXT,
    "customerId" TEXT,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BookingLink_tokenHash_key" ON "BookingLink"("tokenHash");

-- CreateIndex
CREATE INDEX "BookingLink_shopId_appointmentId_idx" ON "BookingLink"("shopId", "appointmentId");

-- CreateIndex
CREATE INDEX "BookingLink_shopId_enrollmentId_idx" ON "BookingLink"("shopId", "enrollmentId");

-- CreateIndex
CREATE UNIQUE INDEX "Shop_bookingSlug_key" ON "Shop"("bookingSlug");

-- AddForeignKey
ALTER TABLE "BookingLink" ADD CONSTRAINT "BookingLink_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

