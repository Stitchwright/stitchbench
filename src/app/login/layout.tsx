import { cookies } from "next/headers";
import { TextSizeStyle } from "@/components/text-size-style";
import { parseTextSize, TEXT_SIZE_COOKIE } from "@/lib/text-size";

// The sign-in page follows the last text size chosen on this device (a cookie set by Settings → Text size).
export default async function LoginLayout({ children }: { children: React.ReactNode }) {
  const size = parseTextSize((await cookies()).get(TEXT_SIZE_COOKIE)?.value);
  return (
    <>
      <TextSizeStyle size={size} />
      {children}
    </>
  );
}
