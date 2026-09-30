// Copies pdf.js's worker and its support files into /public so the browser can draw manual pages:
// wasm image decoders (JBIG2 / JPEG 2000, used by most scanned manuals), CMaps (Asian text), standard fonts, ICC profiles.
import { copyFileSync, cpSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const root = dirname(require.resolve("pdfjs-dist/package.json"));
mkdirSync("public", { recursive: true });
// The legacy build, the one the page loads (src/components/manual-figure.tsx): it works in browsers that lack newer features.
copyFileSync(join(root, "legacy", "build", "pdf.worker.min.mjs"), join("public", "pdf.worker.min.mjs"));
for (const dir of ["wasm", "cmaps", "standard_fonts", "iccs"]) {
  cpSync(join(root, dir), join("public", "pdfjs", dir), { recursive: true });
}
console.log("pdf.js worker and support files copied to public/");
