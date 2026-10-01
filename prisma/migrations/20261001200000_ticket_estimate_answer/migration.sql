-- The customer's answer to an estimate, recorded on the ticket whichever way it arrived (link, phone, text reply).
ALTER TABLE "Ticket" ADD COLUMN "estimateAnswer" TEXT, ADD COLUMN "estimateAnsweredAt" TIMESTAMP(3);
