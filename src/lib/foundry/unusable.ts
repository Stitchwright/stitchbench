import crypto from "node:crypto";
import bcrypt from "bcryptjs";

/**
 * A password hash nobody can match: a real bcrypt hash of 32 random bytes that are thrown away. A login that comes in by a
 * Foundry Account (FA-5) has no password of its own, but the column is never empty and nothing downstream needs to know:
 * every compare simply fails. Pure (no server-only, no database): the seed script and the retire script use it too.
 */
export const unusablePasswordHash = () => bcrypt.hash(crypto.randomBytes(32).toString("base64url"), 10);
