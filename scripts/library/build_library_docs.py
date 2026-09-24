r"""Write prisma/seed-data/library_docs.json from C:\Manuals\index.csv (built by build_index.py)."""
import csv, json, os, hashlib, sys
sys.path.insert(0, os.path.dirname(__file__))
from common import LIB, MACHINE_CATS, model_keys, file_models, doc_type

OUT = os.path.join(os.path.dirname(__file__), "..", "..", "prisma", "seed-data", "library_docs.json")
def clean(s):
    """Strip control characters (some PDF titles carry NULs, which Postgres rejects)."""
    return "".join(ch for ch in (s or "") if ch >= " " or ch in "	").strip()


rows = []
seen = set()
for r in csv.DictReader(open(os.path.join(LIB, "index.csv"), encoding="utf-8")):
    p = r["path"]
    if r["category"] not in MACHINE_CATS or not p.lower().endswith(".pdf") or p in seen:
        continue
    seen.add(p)
    rows.append({
        "id": hashlib.sha1(p.encode("utf-8")).hexdigest()[:20],
        "path": p,
        "category": r["category"],
        "brand": r["brand"],
        "file": clean(r["file"]),
        "docType": doc_type(p),
        "title": clean(r.get("pdf_title"))[:200] or None,
        "pages": int(r["pages"]) if (r.get("pages") or "").isdigit() else None,
        "sizeBytes": int(r["size_bytes"]) if (r.get("size_bytes") or "").isdigit() else None,
        "modelKeys": model_keys(file_models(p), p),
    })
json.dump(rows, open(OUT, "w", encoding="utf-8"), ensure_ascii=False)
print(len(rows), "library docs ->", os.path.abspath(OUT), os.path.getsize(OUT) // 1024, "KB")
