r"""Find the pages of the library's service manuals that describe a test / service / diagnostic mode.

Step one of the Service Modes reference set (docs/HANDOFF.md section 3, item 15). The script only *finds* candidate
pages; the procedures themselves are read on the page and written up by hand, in our own words, in
C:\Manuals\_business-notes\Service_Modes.xlsx (then service_modes_from_xlsx.py turns that sheet into
prisma/seed-data/service_modes.json).

Walks prisma/seed-data/library_docs.json: the service, technical and maintenance manuals, plus files the file-name
rules leave untyped (old NAS names such as SMBLSO.pdf), plus every file the factory settings cite. Pages are 1-based
PDF page numbers, the same numbering the factory settings use.

Usage (on the PC that holds C:\Manuals):
  python scripts/library/extract_service_modes.py                     # candidates -> %TEMP%\service_mode_candidates.csv
  python scripts/library/extract_service_modes.py --out cands.csv --cats Sewing,Embroidery,Industrial-Sewing
  python scripts/library/extract_service_modes.py --brand Brother     # one brand folder only
  python scripts/library/extract_service_modes.py --show "Sewing\Brother\ServiceManuals\X.pdf" 40-42
  python scripts/library/extract_service_modes.py --find "Sewing\Brother\ServiceManuals\X.pdf" "test mode"
  python scripts/library/extract_service_modes.py --render "Sewing\Brother\ServiceManuals\X.pdf" 40-41 --dpi 90

The candidates file holds a short snippet per page for the reviewer only. It is never shipped and stays outside the
repository (default: the system temp folder): OEM text is copyrighted.
"""
import argparse, csv, json, os, re, sys, tempfile

sys.path.insert(0, os.path.dirname(__file__))
from common import LIB  # noqa: E402

try:
    import pymupdf as fitz  # PyMuPDF >= 1.24
except ImportError:  # pragma: no cover
    import fitz

SEED = os.path.join(os.path.dirname(__file__), "..", "..", "prisma", "seed-data")
SERVICE_TYPES = {"ServiceManual", "TechnicalManual", "MaintenanceManual"}

# Phrase -> weight. Strong phrases name a mode; weak ones are the usual "turn on while pressing" wording.
PHRASES = [
    (r"test\s*mode", 3), (r"service\s*mode", 3), (r"maintenance\s*mode", 2), (r"adjust(ment|ing)?\s*mode", 2),
    (r"diagnos(tic|is)", 1), (r"self[-\s]?(test|check|diagnos)", 2), (r"check(ing)?\s*mode", 2),
    (r"test\s*program", 3), (r"service\s*program", 3), (r"check\s*program", 2), (r"inspection\s*mode", 2),
    (r"test\s*menu", 2), (r"service\s*menu", 2), (r"engineer(ing)?\s*mode", 3), (r"factory\s*mode", 2),
    (r"(turn|switch)(ing)?\s+(on\s+)?the\s+(power|main\s+switch|machine)\s+(on\s+)?while", 3),
    (r"power[-\s]on\s+while", 3), (r"while\s+(holding|pressing)", 1), (r"press(ing)?\s+and\s+hold", 1),
    (r"switch\s+on\s+while", 3), (r"turn\s+on\s+while", 3), (r"test\s*no\.?\s*\d", 2), (r"mode\s*no\.?\s*\d", 1),
]
RX = [(re.compile(p, re.I), w, p) for p, w in PHRASES]


def norm(p: str) -> str:
    return p.replace("/", "\\")


def docs(cats: set[str], brand: str | None) -> list[dict]:
    lib = json.load(open(os.path.join(SEED, "library_docs.json"), encoding="utf-8"))
    cited = set()
    try:
        for r in json.load(open(os.path.join(SEED, "factory_settings.json"), encoding="utf-8")):
            if r.get("sourcePath"):
                cited.add(norm(r["sourcePath"]))
    except FileNotFoundError:
        pass
    out = []
    for r in lib:
        if r["category"] not in cats:
            continue
        if brand and r["brand"].lower() != brand.lower():
            continue
        if r["docType"] in SERVICE_TYPES or r["docType"] is None or norm(r["path"]) in cited:
            out.append(r)
    return out


def page_text(doc, i: int) -> str:
    try:
        return doc[i].get_text("text") or ""
    except Exception:
        return ""


def scan(path: str):
    """Yield (page, score, hits, snippet) for each page that names a mode; also return text/page stats."""
    full = os.path.join(LIB, path)
    doc = fitz.open(full)
    rows, chars = [], 0
    for i in range(doc.page_count):
        t = page_text(doc, i)
        chars += len(t.strip())
        flat = re.sub(r"\s+", " ", t)
        score, hits, first = 0, [], None
        for rx, w, p in RX:
            m = rx.search(flat)
            if m:
                n = len(rx.findall(flat))
                score += w * min(n, 3)
                hits.append(m.group(0).lower())
                if first is None or m.start() < first:
                    first = m.start()
        if score >= 2:
            s = max(0, (first or 0) - 60)
            rows.append((i + 1, score, "; ".join(dict.fromkeys(hits)), flat[s:s + 200]))
    n = doc.page_count
    doc.close()
    return rows, n, chars


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(tempfile.gettempdir(), "service_mode_candidates.csv"))
    ap.add_argument("--cats", default="Sewing,Embroidery")
    ap.add_argument("--brand")
    ap.add_argument("--show", nargs=2, metavar=("PATH", "PAGES"), help="print the text of PDF pages, e.g. 40-42")
    ap.add_argument("--find", nargs=2, metavar=("PATH", "REGEX"), help="list the pages of one PDF matching a regex")
    ap.add_argument("--render", nargs=2, metavar=("PATH", "PAGES"),
                    help="render PDF pages to PNG in the temp folder (button icons are pictures, not text)")
    ap.add_argument("--dpi", type=int, default=110)
    a = ap.parse_args()

    if a.render:
        path, pages = a.render
        lo, _, hi = pages.partition("-")
        doc = fitz.open(os.path.join(LIB, norm(path)))
        stem = re.sub(r"[^A-Za-z0-9]+", "_", os.path.splitext(os.path.basename(path))[0])[:40]
        for p in range(int(lo), int(hi or lo) + 1):
            out = os.path.join(tempfile.gettempdir(), f"svc_{stem}_p{p}.png")
            doc[p - 1].get_pixmap(dpi=a.dpi).save(out)
            print(out)
        return

    if a.show:
        path, pages = a.show
        lo, _, hi = pages.partition("-")
        doc = fitz.open(os.path.join(LIB, norm(path)))
        for p in range(int(lo), int(hi or lo) + 1):
            print(f"===== page {p} / {doc.page_count}")
            print(page_text(doc, p - 1))
        return
    if a.find:
        path, rx = a.find
        doc = fitz.open(os.path.join(LIB, norm(path)))
        r = re.compile(rx, re.I)
        for i in range(doc.page_count):
            flat = re.sub(r"\s+", " ", page_text(doc, i))
            m = r.search(flat)
            if m:
                print(i + 1, "|", flat[max(0, m.start() - 80): m.start() + 120])
        return

    todo = docs(set(a.cats.split(",")), a.brand)
    print(len(todo), "documents to scan", file=sys.stderr)
    stats = []
    with open(a.out, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["brand", "category", "file", "path", "pdf_pages", "page", "score", "hits", "snippet"])
        for k, r in enumerate(todo):
            try:
                rows, n, chars = scan(r["path"])
            except Exception as e:  # unreadable / missing file
                stats.append((r["brand"], r["path"], 0, 0, 0, f"error: {e}"))
                continue
            for page, score, hits, snip in rows:
                w.writerow([r["brand"], r["category"], r["file"], r["path"], n, page, score, hits, snip])
            stats.append((r["brand"], r["path"], n, chars, len(rows), "" if chars > 50 * max(n, 1) else "little or no text (scan?)"))
            if k % 25 == 0:
                print(k, r["path"], file=sys.stderr)
    stat_path = os.path.splitext(a.out)[0] + "_docs.csv"
    with open(stat_path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["brand", "path", "pdf_pages", "text_chars", "candidate_pages", "note"])
        w.writerows(stats)
    print("candidates ->", a.out, "; per-document stats ->", stat_path, file=sys.stderr)


if __name__ == "__main__":
    main()
