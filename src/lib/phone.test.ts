// Unit tests for telling a typed phone number from a name (npm run test:unit).
import test from "node:test";
import assert from "node:assert/strict";
import { nameOrPhone } from "./phone";

test("a phone number as people type it goes in Phone", () => {
  for (const s of ["555-0142", " (555) 123 4567 ", "+1 555.123.4567", "0142"]) assert.deepEqual(nameOrPhone(s), { name: "", phone: s.trim() });
});

test("a name, even with a digit in it, goes in Name", () => {
  for (const s of ["Ruth Adams", "Apt 4 Smith", "Ruth 2nd", "Bob 555", "123"]) assert.deepEqual(nameOrPhone(s), { name: s, phone: "" });
});
