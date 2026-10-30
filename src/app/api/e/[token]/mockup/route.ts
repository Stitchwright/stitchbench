// The mock-up picture on a customer's quote and proof page (docs/plans/decorators-proposal.md): found by the link's token alone, for
// the order that link is about. No session. A PNG or JPEG checked when it was saved, served as an image only.
import { allowPublic } from "@/lib/rate-limit";
import { proofMockup } from "@/lib/decor";

const HEADERS = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" };

export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!allowPublic(req, "e-mockup", 60, 60_000)) return new Response("Too many tries. Please wait a minute.", { status: 429, headers: HEADERS });
  const f = await proofMockup(token);
  if (!f) return new Response("Not found.", { status: 404, headers: HEADERS });
  return new Response(Buffer.from(f.data), { headers: { ...HEADERS, "Content-Type": f.mime } });
}
