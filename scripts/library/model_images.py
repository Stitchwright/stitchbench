r"""Cut a picture of each machine from its own manual.
Looks, in order, for: the machine drawing on a "Names of parts" page, then the biggest photo or
drawing on the first pages. A manual with no picture is skipped (never a text-only cover).
Writes <MEDIA>/models/<id>.jpg and <MEDIA>/models.json. One picture per manual; operator manuals first.
usage: python model_images.py [--fresh]"""
import json, os, re, sys, hashlib, shutil
import pymupdf
sys.path.insert(0, os.path.dirname(__file__))
from common import LIB, MEDIA, file_models

SRC = os.path.join(os.path.dirname(__file__), "..", "..", "prisma", "seed-data", "library_docs.json")
OUT = os.path.join(MEDIA, "models")
man_path = os.path.join(MEDIA, "models.json")
if "--fresh" in sys.argv:
    shutil.rmtree(OUT, ignore_errors=True)
    if os.path.exists(man_path):
        os.remove(man_path)
os.makedirs(OUT, exist_ok=True)
manifest = {m["id"]: m for m in json.load(open(man_path))} if os.path.exists(man_path) else {}

PARTS_PAGE = re.compile(r"names? of (?:main |the )?(?:parts|each part|components)|principal parts|part names|"
                        r"identif(?:y|ication) of (?:parts|machine)|machine (?:parts|components)|getting to know your machine|"
                        r"bezeichnung der teile", re.I)

docs = [d for d in json.load(open(SRC, encoding="utf-8")) if d["modelKeys"] and d["docType"] not in ("PartsList", "Brochure")]
rank = {"OperatorManual": 0, "ServiceManual": 1, "TechnicalManual": 1, "MaintenanceManual": 2}
docs.sort(key=lambda d: (rank.get(d["docType"], 3), d["path"]))
covered = set()
for m in manifest.values():
    for k in m["modelKeys"]:
        covered.add((m["brand"].upper(), k))


def text_cover(pg, r, words):
    """Share of the rect covered by words: tables and text blocks are high, machine drawings low."""
    a = r.width * r.height
    covered = 0.0
    for w in words:
        wr = pymupdf.Rect(w[:4]) & r
        if not wr.is_empty:
            covered += wr.width * wr.height
    return covered / max(1, a)


def graphics(pg):
    """Rects of photos and vector machine drawings on a page (not whole-page scans, not tables), biggest first."""
    area = pg.rect.width * pg.rect.height
    words = pg.get_text("words")
    out = []
    for info in pg.get_image_info():
        r = pymupdf.Rect(info["bbox"]) & pg.rect
        if not r.is_empty and 0.10 < (r.width * r.height) / area < 0.95 and text_cover(pg, r, words) < 0.12:
            out.append(r)
    try:
        drawings = pg.get_drawings()
        for r in pg.cluster_drawings(drawings=drawings):
            r = r & pg.rect
            if r.is_empty or not 0.10 < (r.width * r.height) / area < 0.95:
                continue
            # machine drawings are full of curves; tables and boxes are straight lines
            curves = sum(1 for p in drawings if pymupdf.Rect(p["rect"]).intersects(r) for it in p["items"] if it[0] == "c")
            if curves >= 25 and text_cover(pg, r, words) < 0.08:
                out.append(r)
    except Exception:
        pass
    good = [r for r in out if 0.45 < r.width / max(1, r.height) < 2.6]
    return sorted(good, key=lambda r: -(r.width * r.height))


def photo_like(pg, r):
    """A real photo has many grey tones; cover stripes, logos and icons have a handful."""
    pix = pg.get_pixmap(matrix=pymupdf.Matrix(0.5, 0.5), clip=r, colorspace=pymupdf.csGRAY)
    levels = [0] * 256
    for b in pix.samples:
        levels[b] += 1
    n = len(pix.samples) or 1
    used = sum(1 for c in levels if c > n * 0.002)
    white = sum(levels[200:]) / n  # scanned text pages are mostly white paper
    return used >= 70 and white < 0.6


def detailed_drawing(pg, r, drawings):
    curves = sum(1 for p in drawings if pymupdf.Rect(p["rect"]).intersects(r) for it in p["items"] if it[0] == "c")
    return curves >= 80


def pick(doc, operator: bool):
    n = doc.page_count
    # 1) the machine drawing on a "names of parts" page in the first 15 pages
    for i in range(min(15, n)):
        pg = doc[i]
        if PARTS_PAGE.search((pg.get_text("text") or "")[:3000]):
            g = graphics(pg)
            if g:
                return i, g[0]
    # 2) otherwise the biggest detailed drawing on the first 6 pages, or (operator manuals only)
    #    a real photo on the first 2 pages; service-manual photos are usually internal close-ups
    best = None
    for i in range(min(6, n)):
        pg = doc[i]
        drawings = None
        for r in graphics(pg):
            if best and r.width * r.height <= best[1].width * best[1].height:
                break
            if operator and i < 2 and photo_like(pg, r):
                best = (i, r)
                break
            drawings = drawings if drawings is not None else pg.get_drawings()
            if detailed_drawing(pg, r, drawings):
                best = (i, r)
                break
    return best


done = skipped = 0
for d in docs:
    keys = [k for k in d["modelKeys"] if (d["brand"].upper(), k) not in covered]
    if not keys:
        continue
    iid = hashlib.sha1(d["path"].encode("utf-8")).hexdigest()[:20]
    try:
        doc = pymupdf.open(os.path.join(LIB, d["path"]))
        found = pick(doc, d["docType"] == "OperatorManual") if doc.page_count else None
        if not found:
            doc.close()
            skipped += 1
            continue
        pno, clip = found
        clip = pymupdf.Rect(clip.x0 - 6, clip.y0 - 6, clip.x1 + 6, clip.y1 + 6) & doc[pno].rect
        zoom = min(2.5, 600 / max(1, clip.width))
        pix = doc[pno].get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), clip=clip)
        doc.close()
        pix.save(os.path.join(OUT, iid + ".jpg"), jpg_quality=72)
        manifest[iid] = {"id": iid, "brand": d["brand"], "models": file_models(d["path"]), "modelKeys": d["modelKeys"],
                         "sourcePath": d["path"], "page": pno + 1, "width": pix.width, "height": pix.height}
        for k in d["modelKeys"]:
            covered.add((d["brand"].upper(), k))
        done += 1
        if done % 200 == 0:
            json.dump(list(manifest.values()), open(man_path, "w"))
            print(done, "pictures,", skipped, "manuals without one", flush=True)
    except Exception as e:
        print("skip", d["path"], repr(e)[:100], flush=True)
json.dump(list(manifest.values()), open(man_path, "w"))
size = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT))
print(f"done: {done} new, {len(manifest)} total, {skipped} manuals without a picture, {size / 1e6:.0f} MB", flush=True)
