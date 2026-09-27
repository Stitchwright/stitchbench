-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "lastReviewAskAt" TIMESTAMP(3),
ADD COLUMN     "notifyBy" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "smsConsentAt" TIMESTAMP(3),
ADD COLUMN     "smsConsentPhone" TEXT,
ADD COLUMN     "smsConsentSource" TEXT,
ADD COLUMN     "smsConsentText" TEXT;

-- AlterTable
ALTER TABLE "Machine" ADD COLUMN     "serviceNoticeFor" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "pickupReadyAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SaleLine" ADD COLUMN     "appointmentId" TEXT,
ADD COLUMN     "enrollmentId" TEXT;

-- AlterTable
ALTER TABLE "PartnerLink" ADD COLUMN     "features" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "featuresHash" TEXT;

-- AlterTable
ALTER TABLE "RepairJob" ADD COLUMN     "backAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PartnerRun" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "ownerSide" TEXT NOT NULL,
    "rev" INTEGER NOT NULL DEFAULT 1,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "driver" TEXT NOT NULL DEFAULT 'repair',
    "collect" TEXT[],
    "deliver" TEXT[],
    "collected" TEXT[],
    "collectedAt" TIMESTAMP(3),
    "delivered" TEXT[],
    "deliveredAt" TIMESTAMP(3),
    "note" TEXT,
    "okRev" INTEGER,
    "okAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "events" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartnerRun_pkey" PRIMARY KEY ("shopId","id")
);

-- CreateTable
CREATE TABLE "MessagingSettings" (
    "shopId" TEXT NOT NULL,
    "emailOn" BOOLEAN NOT NULL DEFAULT false,
    "smtpPreset" TEXT,
    "smtpHost" TEXT,
    "smtpPort" INTEGER NOT NULL DEFAULT 587,
    "smtpSecurity" TEXT NOT NULL DEFAULT 'starttls',
    "smtpUser" TEXT,
    "smtpPassSealed" TEXT,
    "smtpPassSavedAt" TIMESTAMP(3),
    "fromName" TEXT,
    "fromEmail" TEXT,
    "replyTo" TEXT,
    "replyWatchedAt" TIMESTAMP(3),
    "replyWatchedBy" TEXT,
    "emailDailyCap" INTEGER NOT NULL DEFAULT 300,
    "smsOn" BOOLEAN NOT NULL DEFAULT false,
    "twilioSid" TEXT,
    "twilioKeySid" TEXT,
    "twilioTokenSealed" TEXT,
    "twilioTokenSavedAt" TIMESTAMP(3),
    "twilioFrom" TEXT,
    "smsDailyCap" INTEGER NOT NULL DEFAULT 300,
    "smsPartMills" INTEGER NOT NULL DEFAULT 11,
    "testPhones" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "testPhonePending" TEXT,
    "testCodeHash" TEXT,
    "testCodeUntil" TIMESTAMP(3),
    "inboundAt" TIMESTAMP(3),
    "inboundIncomplete" INTEGER NOT NULL DEFAULT 0,
    "emailOkAt" TIMESTAMP(3),
    "emailError" TEXT,
    "emailPausedAt" TIMESTAMP(3),
    "emailPausedUntil" TIMESTAMP(3),
    "emailCheckAt" TIMESTAMP(3),
    "smsOkAt" TIMESTAMP(3),
    "smsError" TEXT,
    "smsPausedAt" TIMESTAMP(3),
    "smsPausedUntil" TIMESTAMP(3),
    "smsCheckAt" TIMESTAMP(3),
    "marketingHoldAt" TIMESTAMP(3),
    "textHoldAt" TIMESTAMP(3),
    "textHoldWhy" TEXT,
    "postalAddress" TEXT,
    "tzConfirmedAt" TIMESTAMP(3),
    "tzConfirmedBy" TEXT,
    "quietStart" INTEGER NOT NULL DEFAULT 540,
    "quietEnd" INTEGER NOT NULL DEFAULT 1200,
    "noSundayMarketing" BOOLEAN NOT NULL DEFAULT true,
    "smsConsentText" TEXT,
    "consentTexts" JSONB NOT NULL DEFAULT '[]',
    "readyNotice" BOOLEAN NOT NULL DEFAULT true,
    "reminders" BOOLEAN NOT NULL DEFAULT true,
    "reminderHour" INTEGER NOT NULL DEFAULT 10,
    "abandonNotices" BOOLEAN NOT NULL DEFAULT false,
    "abandonDays" INTEGER[] DEFAULT ARRAY[7, 30]::INTEGER[],
    "finalNoticeDays" INTEGER NOT NULL DEFAULT 7,
    "serviceDue" BOOLEAN NOT NULL DEFAULT false,
    "serviceDueMonths" INTEGER NOT NULL DEFAULT 12,
    "serviceDueSince" TIMESTAMP(3),
    "serviceDueDay" TEXT,
    "reviewRequest" BOOLEAN NOT NULL DEFAULT false,
    "reviewUrl" TEXT,
    "reviewDelayHours" INTEGER NOT NULL DEFAULT 24,
    "reviewEveryDays" INTEGER NOT NULL DEFAULT 180,
    "reviewAfterSales" BOOLEAN NOT NULL DEFAULT false,
    "estimateLinkDays" INTEGER NOT NULL DEFAULT 7,
    "templates" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessagingSettings_pkey" PRIMARY KEY ("shopId")
);

-- CreateTable
CREATE TABLE "OutMessage" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "customerId" TEXT,
    "address" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "dedupeKey" TEXT,
    "sendAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notAfter" TIMESTAMP(3),
    "tries" INTEGER NOT NULL DEFAULT 0,
    "retryTries" INTEGER NOT NULL DEFAULT 0,
    "nextTryAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "providerId" TEXT,
    "deliveryStatus" TEXT,
    "deliveryError" TEXT,
    "error" TEXT,
    "optOutToken" TEXT,
    "ticketId" TEXT,
    "repairJobId" TEXT,
    "campaignId" TEXT,
    "refType" TEXT,
    "refId" TEXT,
    "byUserId" TEXT,
    "cancelledById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Suppression" (
    "shopId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Suppression_pkey" PRIMARY KEY ("shopId","channel","address")
);

-- CreateTable
CREATE TABLE "ConsentEvent" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "customerId" TEXT,
    "channel" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "address" TEXT,
    "source" TEXT NOT NULL,
    "detail" TEXT,
    "byUserId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboundText" (
    "shopId" TEXT NOT NULL,
    "sid" TEXT NOT NULL,
    "fromNumber" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "customerId" TEXT,
    "keyword" TEXT,
    "handledAt" TIMESTAMP(3),
    "handledBy" TEXT,

    CONSTRAINT "InboundText_pkey" PRIMARY KEY ("shopId","sid")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "audience" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "members" JSONB NOT NULL DEFAULT '[]',
    "built" INTEGER NOT NULL DEFAULT 0,
    "queuedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "recipients" INTEGER NOT NULL DEFAULT 0,
    "skipped" JSONB NOT NULL DEFAULT '{}',
    "createdById" TEXT,
    "queuedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EstimateLink" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenSealed" TEXT,
    "maskedUrl" TEXT NOT NULL,
    "ticketId" TEXT,
    "repairJobId" TEXT,
    "customerId" TEXT,
    "totalCents" INTEGER NOT NULL,
    "lines" JSONB NOT NULL,
    "note" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "answer" TEXT,
    "answerNote" TEXT,
    "answeredAt" TIMESTAMP(3),
    "answerFrom" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EstimateLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobLease" (
    "name" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "until" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobLease_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "ShopClass" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "teacher" TEXT,
    "location" TEXT,
    "supplies" TEXT,
    "feeCents" INTEGER NOT NULL DEFAULT 0,
    "taxable" BOOLEAN NOT NULL DEFAULT false,
    "seats" INTEGER NOT NULL,
    "waitlist" BOOLEAN NOT NULL DEFAULT true,
    "remind" TEXT NOT NULL DEFAULT 'every',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "firstAt" TIMESTAMP(3),
    "lastAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopClass_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassMeeting" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "cancelled" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,

    CONSTRAINT "ClassMeeting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Enrollment" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "customerId" TEXT,
    "name" TEXT NOT NULL,
    "attendee" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ENROLLED',
    "feeCents" INTEGER NOT NULL,
    "taxable" BOOLEAN NOT NULL DEFAULT false,
    "paidCents" INTEGER,
    "paidAt" TIMESTAMP(3),
    "paidLineId" TEXT,
    "refundedCents" INTEGER,
    "refundedAt" TIMESTAMP(3),
    "refundLineId" TEXT,
    "note" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Enrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppointmentType" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL DEFAULT 60,
    "feeCents" INTEGER NOT NULL DEFAULT 0,
    "taxable" BOOLEAN NOT NULL DEFAULT false,
    "capacity" INTEGER NOT NULL DEFAULT 1,
    "resource" TEXT,
    "hours" JSONB NOT NULL DEFAULT '[]',
    "location" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppointmentType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Appointment" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "typeId" TEXT,
    "resource" TEXT,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "customerId" TEXT,
    "name" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'BOOKED',
    "staffId" TEXT,
    "ticketId" TEXT,
    "repairJobId" TEXT,
    "feeCents" INTEGER NOT NULL DEFAULT 0,
    "taxable" BOOLEAN NOT NULL DEFAULT false,
    "paidCents" INTEGER,
    "paidAt" TIMESTAMP(3),
    "paidLineId" TEXT,
    "refundedCents" INTEGER,
    "refundedAt" TIMESTAMP(3),
    "refundLineId" TEXT,
    "note" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shift" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "userId" TEXT,
    "name" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "role" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PartnerRun_shopId_linkId_startsAt_idx" ON "PartnerRun"("shopId", "linkId", "startsAt");

-- CreateIndex
CREATE INDEX "PartnerRun_shopId_startsAt_idx" ON "PartnerRun"("shopId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutMessage_optOutToken_key" ON "OutMessage"("optOutToken");

-- CreateIndex
CREATE INDEX "OutMessage_status_sendAfter_idx" ON "OutMessage"("status", "sendAfter");

-- CreateIndex
CREATE INDEX "OutMessage_shopId_status_sendAfter_idx" ON "OutMessage"("shopId", "status", "sendAfter");

-- CreateIndex
CREATE INDEX "OutMessage_shopId_createdAt_idx" ON "OutMessage"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "OutMessage_shopId_customerId_idx" ON "OutMessage"("shopId", "customerId");

-- CreateIndex
CREATE INDEX "OutMessage_shopId_ticketId_idx" ON "OutMessage"("shopId", "ticketId");

-- CreateIndex
CREATE INDEX "OutMessage_shopId_repairJobId_idx" ON "OutMessage"("shopId", "repairJobId");

-- CreateIndex
CREATE INDEX "OutMessage_shopId_address_sentAt_idx" ON "OutMessage"("shopId", "address", "sentAt");

-- CreateIndex
CREATE INDEX "OutMessage_campaignId_status_idx" ON "OutMessage"("campaignId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "OutMessage_shopId_dedupeKey_key" ON "OutMessage"("shopId", "dedupeKey");

-- CreateIndex
CREATE INDEX "ConsentEvent_shopId_customerId_at_idx" ON "ConsentEvent"("shopId", "customerId", "at");

-- CreateIndex
CREATE INDEX "ConsentEvent_shopId_at_idx" ON "ConsentEvent"("shopId", "at");

-- CreateIndex
CREATE INDEX "InboundText_shopId_receivedAt_idx" ON "InboundText"("shopId", "receivedAt");

-- CreateIndex
CREATE INDEX "InboundText_shopId_fromNumber_receivedAt_idx" ON "InboundText"("shopId", "fromNumber", "receivedAt");

-- CreateIndex
CREATE INDEX "Campaign_shopId_createdAt_idx" ON "Campaign"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "Campaign_status_idx" ON "Campaign"("status");

-- CreateIndex
CREATE UNIQUE INDEX "EstimateLink_tokenHash_key" ON "EstimateLink"("tokenHash");

-- CreateIndex
CREATE INDEX "EstimateLink_shopId_ticketId_idx" ON "EstimateLink"("shopId", "ticketId");

-- CreateIndex
CREATE INDEX "EstimateLink_shopId_repairJobId_idx" ON "EstimateLink"("shopId", "repairJobId");

-- CreateIndex
CREATE INDEX "EstimateLink_shopId_answeredAt_idx" ON "EstimateLink"("shopId", "answeredAt");

-- CreateIndex
CREATE INDEX "ShopClass_shopId_firstAt_idx" ON "ShopClass"("shopId", "firstAt");

-- CreateIndex
CREATE INDEX "ClassMeeting_shopId_startsAt_idx" ON "ClassMeeting"("shopId", "startsAt");

-- CreateIndex
CREATE INDEX "ClassMeeting_classId_startsAt_idx" ON "ClassMeeting"("classId", "startsAt");

-- CreateIndex
CREATE INDEX "Enrollment_classId_customerId_idx" ON "Enrollment"("classId", "customerId");

-- CreateIndex
CREATE INDEX "Enrollment_shopId_customerId_idx" ON "Enrollment"("shopId", "customerId");

-- CreateIndex
CREATE INDEX "Enrollment_classId_status_createdAt_idx" ON "Enrollment"("classId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "AppointmentType_shopId_sortOrder_idx" ON "AppointmentType"("shopId", "sortOrder");

-- CreateIndex
CREATE INDEX "Appointment_shopId_startsAt_idx" ON "Appointment"("shopId", "startsAt");

-- CreateIndex
CREATE INDEX "Appointment_shopId_customerId_idx" ON "Appointment"("shopId", "customerId");

-- CreateIndex
CREATE INDEX "Appointment_typeId_startsAt_idx" ON "Appointment"("typeId", "startsAt");

-- CreateIndex
CREATE INDEX "Appointment_shopId_resource_startsAt_idx" ON "Appointment"("shopId", "resource", "startsAt");

-- CreateIndex
CREATE INDEX "Shift_shopId_startsAt_idx" ON "Shift"("shopId", "startsAt");

-- CreateIndex
CREATE INDEX "Shift_userId_startsAt_idx" ON "Shift"("userId", "startsAt");

-- CreateIndex
CREATE INDEX "Ticket_shopId_machineId_intakeAt_idx" ON "Ticket"("shopId", "machineId", "intakeAt");

-- CreateIndex
CREATE INDEX "SaleLine_enrollmentId_idx" ON "SaleLine"("enrollmentId");

-- CreateIndex
CREATE INDEX "SaleLine_appointmentId_idx" ON "SaleLine"("appointmentId");

-- CreateIndex
CREATE INDEX "RepairJob_shopId_machineId_idx" ON "RepairJob"("shopId", "machineId");

-- AddForeignKey
ALTER TABLE "PartnerRun" ADD CONSTRAINT "PartnerRun_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessagingSettings" ADD CONSTRAINT "MessagingSettings_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutMessage" ADD CONSTRAINT "OutMessage_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutMessage" ADD CONSTRAINT "OutMessage_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutMessage" ADD CONSTRAINT "OutMessage_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Suppression" ADD CONSTRAINT "Suppression_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentEvent" ADD CONSTRAINT "ConsentEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentEvent" ADD CONSTRAINT "ConsentEvent_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InboundText" ADD CONSTRAINT "InboundText_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EstimateLink" ADD CONSTRAINT "EstimateLink_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopClass" ADD CONSTRAINT "ShopClass_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassMeeting" ADD CONSTRAINT "ClassMeeting_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassMeeting" ADD CONSTRAINT "ClassMeeting_classId_fkey" FOREIGN KEY ("classId") REFERENCES "ShopClass"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_classId_fkey" FOREIGN KEY ("classId") REFERENCES "ShopClass"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppointmentType" ADD CONSTRAINT "AppointmentType_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES "AppointmentType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Backfill (hand-written): machines already on the pickup shelf count from when they became ready
UPDATE "Ticket" SET "pickupReadyAt" = "readyAt" WHERE "status" = 'READY_FOR_PICKUP' AND "pickupReadyAt" IS NULL;
