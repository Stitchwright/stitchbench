"use server";

// Pasting a license key (Settings -> Modules). The body is in src/lib/licenses.ts.
import { safe } from "@/lib/action";
import { requireAdmin } from "@/lib/session";
import { activateLicenseFor } from "@/lib/licenses";

export const activateLicense = safe.whileLapsed("activateLicense")(async (fd: FormData) => activateLicenseFor(await requireAdmin(), fd));
