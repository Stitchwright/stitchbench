-- The note typed when a partnership is ended, and who ended it, kept on the link so the other shop can read it.
ALTER TABLE "PartnerLink" ADD COLUMN "endNote" TEXT;
ALTER TABLE "PartnerLink" ADD COLUMN "endedBy" TEXT;
