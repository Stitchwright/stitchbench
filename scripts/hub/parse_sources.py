r"""Build the community hub's starting manual-link catalog from the library's SOURCES*.md files.
Every table row that names a filed manual ("Filed as" / file column) and a source URL becomes a link:
brand, models and document type come from the Brand_Model_DocType_Year.pdf file name. Only links are kept, never files.
usage: python scripts/hub/parse_sources.py [C:\Manuals] > prisma/seed-data/hub_links.json"""
import json, os, re, sys

LIB = sys.argv[1] if len(sys.argv) > 1 else r"C:\Manuals"
DOC_TYPES = ["ServiceManual", "TechnicalManual", "MaintenanceManual", "PartsList", "OperatorManual", "ErrorCodes",
             "WiringDiagram", "Schematic", "Firmware", "Training", "Bulletin"]
URL = re.compile(r"https?://[^\s|)`>\]]+")
FILE = re.compile(r"`?([^`|]*?\.pdf)`?", re.I)


def cells(line):
    return [c.strip() for c in line.strip().strip("|").split("|")]


def find_col(header, *names):
    for i, h in enumerate(header):
        h2 = re.sub(r"[^a-z ]", "", h.lower())
        if any(n in h2 for n in names):
            return i
    return None


def real_date(text):
    """First yyyy-mm-dd in the text that is an actual date (verified columns sometimes hold part numbers)."""
    import datetime
    for m in re.finditer(r"(20\d\d)-(\d\d)-(\d\d)", text or ""):
        try:
            return datetime.date(*map(int, m.groups())).isoformat()
        except ValueError:
            continue
    return None


def from_filename(name):
    base = os.path.basename(name.replace("\\", "/"))
    stem = re.sub(r"\.pdf$", "", base, flags=re.I)
    parts = stem.split("_")
    brand = parts[0] if len(parts) >= 2 else None
    doc = next((d for d in DOC_TYPES if any(p.startswith(d) for p in parts[1:])), None)
    models = parts[1] if len(parts) >= 3 else None
    return base, brand, models.replace("+", ", ") if models else None, doc


out, seen = [], set()
for cat in sorted(os.listdir(LIB)):
    d = os.path.join(LIB, cat)
    if not os.path.isdir(d) or cat.startswith("_"):
        continue
    for fn in sorted(os.listdir(d)):
        if not (fn.startswith("SOURCES") and fn.endswith(".md")):
            continue
        header = None
        for line in open(os.path.join(d, fn), encoding="utf-8", errors="replace"):
            if not line.lstrip().startswith("|"):
                header = None
                continue
            c = cells(line)
            if all(re.fullmatch(r":?-{2,}:?", x) or not x for x in c):
                continue
            if header is None:
                header = c
                fcol = find_col(header, "filed as", "filed", "file", "saved as")
                ucol = find_col(header, "source url", "url", "link", "source")
                icol = find_col(header, "whats inside", "what", "detail", "contents", "document")
                vcol = find_col(header, "verified", "status")
                continue
            if fcol is None or ucol is None or fcol >= len(c) or ucol >= len(c):
                continue
            fm = FILE.search(c[fcol])
            um = URL.search(c[ucol])
            if not fm or not um:
                continue
            url = um.group(0).rstrip(".,;")
            dead = "~~" in c[ucol] and c[ucol].find("~~") < c[ucol].find(url)
            file, brand, models, doc = from_filename(fm.group(1))
            if not brand or not models:
                continue
            key = (url, file.lower())
            if key in seen:
                continue
            seen.add(key)
            inside = re.sub(r"\s+", " ", c[icol]) if icol is not None and icol < len(c) and icol not in (fcol, ucol) else ""
            verified = c[vcol] if vcol is not None and vcol < len(c) else ""
            out.append({
                "category": cat,
                "brand": brand,
                "models": models,
                "docType": doc,
                "title": (inside[:200] or file),
                "fileName": file,
                "url": url,
                "source": re.sub(r"^www\.", "", url.split("/")[2]),
                "status": "dead" if dead else ("ok" if re.search(r"\b(200|206)\b", verified) else "unchecked"),
                "checked": real_date(verified) if not dead else None,
                "from": f"{cat}\\{fn}",
            })
json.dump(out, sys.stdout, ensure_ascii=False, indent=0)
print(f"{len(out)} links", file=sys.stderr)
