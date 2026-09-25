-- Fill the matching keys for parts that existed before the cross-reference.
UPDATE "Part" SET "numberKeys" = ARRAY[regexp_replace(upper("partNumber"), '[^A-Z0-9]', '', 'g')]
WHERE "numberKeys" IS NULL OR cardinality("numberKeys") = 0;
UPDATE "Part" SET "altNumbers" = '{}' WHERE "altNumbers" IS NULL;
