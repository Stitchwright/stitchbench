r"""Cut the manual figure for each factory setting into a JPEG (grayscale) so it can be stored online.
usage: python render_figures.py [Category ...]   (default: Sewing Embroidery Longarm)
Writes <MEDIA>/figures/<id>.jpg and <MEDIA>/figures.json. Re-runs skip figures already cut."""
import json, os, sys
import pymupdf
sys.path.insert(0, os.path.dirname(__file__))
from common import LIB, MEDIA, figure_id

cats = set(sys.argv[1:] or ["Sewing", "Embroidery", "Longarm"])
SRC = os.path.join(os.path.dirname(__file__), "..", "..", "prisma", "seed-data", "factory_settings.json")
OUT = os.path.join(MEDIA, "figures")
os.makedirs(OUT, exist_ok=True)
man_path = os.path.join(MEDIA, "figures.json")
try:
    manifest = {m["id"]: m for m in json.load(open(man_path))} if os.path.exists(man_path) else {}
except ValueError:
    manifest = {}  # damaged (e.g. two runs at once); rebuilt from the image files below

settings = json.load(open(SRC, encoding="utf-8"))
todo = {}
known = {}
for s in settings:
    if s.get("figurePage"):
        fid = figure_id(s["sourcePath"], s["figurePage"], s["figureBox"])
        known.setdefault(fid, (s["sourcePath"], s["figurePage"], s["figureBox"]))
        if s["category"] in cats:
            todo.setdefault(fid, known[fid])

# Put back any already-cut figure the manifest doesn't list (size read from the JPEG).
for f in os.listdir(OUT):
    fid = f[:-4]
    if f.endswith(".jpg") and fid not in manifest and fid in known:
        path, page, box = known[fid]
        try:
            pm = pymupdf.Pixmap(os.path.join(OUT, f))
        except Exception:
            os.remove(os.path.join(OUT, f))  # half-written by an interrupted run; cut again below
            continue
        manifest[fid] = {"id": fid, "sourcePath": path, "page": page, "box": list(box), "width": pm.width, "height": pm.height}
json.dump(list(manifest.values()), open(man_path, "w"))
print(len(todo), "figures wanted,", sum(1 for f in todo if f in manifest), "already cut", flush=True)

open_doc = (None, None)
done = 0
for fid, (path, page, box) in sorted(todo.items(), key=lambda kv: kv[1][0]):
    if fid in manifest and os.path.exists(os.path.join(OUT, fid + ".jpg")):
        continue
    try:
        if open_doc[0] != path:
            if open_doc[1]: open_doc[1].close()
            open_doc = (path, pymupdf.open(os.path.join(LIB, path)))
        doc = open_doc[1]
        if page < 1 or page > doc.page_count:
            continue
        pg = doc[page - 1]
        r = pg.rect
        x0, y0, x1, y1 = box if len(box) == 4 else (0, 0, 1, 1)
        clip = pymupdf.Rect(r.x0 + x0 * r.width, r.y0 + y0 * r.height, r.x0 + x1 * r.width, r.y0 + y1 * r.height)
        zoom = min(2.2, 900 / max(1, clip.width))  # ~900 px wide, never more than ~160 dpi
        pix = pg.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), clip=clip, colorspace=pymupdf.csGRAY)
        fn = os.path.join(OUT, fid + ".jpg")
        pix.save(fn, jpg_quality=62)
        manifest[fid] = {"id": fid, "sourcePath": path, "page": page, "box": list(box), "width": pix.width, "height": pix.height}
        done += 1
        if done % 250 == 0:
            json.dump(list(manifest.values()), open(man_path, "w"))
            print(done, "cut", flush=True)
    except Exception as e:
        print("skip", path, page, repr(e)[:120], flush=True)
json.dump(list(manifest.values()), open(man_path, "w"))
size = sum(os.path.getsize(os.path.join(OUT, f)) for f in os.listdir(OUT))
print(f"done: {done} new, {len(manifest)} total, {size / 1e6:.0f} MB", flush=True)
