-- A part number is one number in any case: the forms, the import and the scanner treat "xa1234" and "XA1234" as the
-- same item, but the unique key was case-sensitive, so two people adding the number at the same moment in different
-- cases got two items. The key is now on ("shopId", lower("partNumber")). Prisma's schema can't express it, so it lives
-- here; the schema keeps @@unique([shopId, partNumber]) as well, which stays true whenever this one does.
--
-- An install that already holds the same number in two cases can't be merged safely in SQL (stock, sales and ticket
-- lines hang off each item), so the item that came first keeps its number and each later one is renamed
-- "<number> (dup 2)", "(dup 3)"...: the number it had goes among its other numbers (a scan still finds it) and a
-- note on the item says what happened, for the shop to merge them or give it a number of its own.
DO $$
DECLARE
  r RECORD;
  n INT;
  candidate TEXT;
  candidate_key TEXT;
BEGIN
  FOR r IN
    SELECT p.id, p."shopId", p."partNumber"
    FROM "Part" p
    WHERE EXISTS (
      SELECT 1 FROM "Part" q
      WHERE q."shopId" = p."shopId" AND lower(q."partNumber") = lower(p."partNumber")
        AND (q."createdAt", q.id) < (p."createdAt", p.id)
    )
    ORDER BY p."shopId", lower(p."partNumber"), p."createdAt", p.id
  LOOP
    n := 2;
    LOOP
      candidate := r."partNumber" || ' (dup ' || n || ')';
      EXIT WHEN NOT EXISTS (SELECT 1 FROM "Part" q WHERE q."shopId" = r."shopId" AND lower(q."partNumber") = lower(candidate));
      n := n + 1;
    END LOOP;
    candidate_key := regexp_replace(upper(candidate), '[^A-Z0-9]', '', 'g');
    UPDATE "Part" SET
      "partNumber" = candidate,
      "altNumbers" = CASE WHEN r."partNumber" = ANY("altNumbers") THEN "altNumbers" ELSE array_append("altNumbers", r."partNumber") END,
      "numberKeys" = CASE WHEN candidate_key = ANY("numberKeys") THEN "numberKeys" ELSE array_append("numberKeys", candidate_key) END,
      notes = concat_ws('; ', notes, 'Renamed from ' || r."partNumber" || ' (another item has the same number in another case): merge them, or give this one its own number.')
    WHERE id = r.id;
  END LOOP;
END $$;

-- The key itself. The schema's own key, "Part_shopId_partNumber_key", stays.
CREATE UNIQUE INDEX IF NOT EXISTS "Part_shopId_partNumber_lower_key" ON "Part" ("shopId", lower("partNumber"));
