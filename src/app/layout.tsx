import type { Metadata, Viewport } from "next";
import { Source_Sans_3, IBM_Plex_Mono } from "next/font/google";
import { Toaster } from "sonner";
import "./globals.css";

const body = Source_Sans_3({ variable: "--font-body", subsets: ["latin"] });
const code = IBM_Plex_Mono({ variable: "--font-code", subsets: ["latin"], weight: ["400", "600"] });

export const metadata: Metadata = {
  title: process.env.APP_NAME === "StitchShop" ? "StitchShop" : "StitchBench",
  description: "Machines, manuals, tension specs, tickets and parts for sewing machine repair.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${body.variable} ${code.variable} h-full antialiased`}>
      <body className="min-h-full">
        {children}
        <Toaster position="bottom-right" richColors />
      </body>
    </html>
  );
}
