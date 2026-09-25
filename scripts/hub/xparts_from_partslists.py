r"""Starting parts cross-reference for the community hub, from the part numbers already read out of the
library's parts lists (C:\Manuals\_business-notes\parts_overlap_cache.json: number -> parts lists it appears in).

Only numbers that appear in two or more machines' parts lists are kept (that's what a cross-reference is for).
Every fit is marked "listed" (the number is in that model's parts list). That shows a shared parts bin, not that a
tech tried it; techs mark real fits as "tested" in StitchBench. Descriptions in those lists are unreliable, so
entries start with a plain name and techs rename them.
usage: python scripts/hub/xparts_from_partslists.py > prisma/seed-data/hub_xparts.json"""
import json
import re
import sys

CACHE = sys.argv[1] if len(sys.argv) > 1 else r"C:\Manuals\_business-notes\parts_overlap_cache.json"
BRAND = {"Husqvarna-Viking": "Husqvarna Viking", "Baby-Lock": "Baby Lock"}


def models_of(path):
    """'Janome/Janome_1100D+1200D_PartsList.pdf' -> ('Janome', ['1100D', '1200D'])."""
    folder, name = path.split("/")[0], path.split("/")[-1]
    parts = re.sub(r"\.pdf$", "", name, flags=re.I).split("_")
    if len(parts) < 3:
        return BRAND.get(folder, folder), []
    return BRAND.get(folder, folder), [m for m in parts[1].split("+") if m]


def key(s):
    return re.sub(r"[^A-Z0-9]", "", s.upper())


cache = json.load(open(CACHE, encoding="utf-8"))
out = []
for number, lists in sorted(cache.items()):
    fits = {}
    brands = []
    for path in lists:
        brand, models = models_of(path)
        if brand not in brands:
            brands.append(brand)
        for m in models:
            fits.setdefault((brand, key(m)), {"brand": brand, "model": m, "modelKey": key(m), "evidence": "listed", "source": path.split("/")[-1]})
    if len(fits) < 2:
        continue
    out.append({
        "name": f"{' / '.join(brands)} part {number}",
        "kind": "PART",
        "category": None,
        "numbers": [{"brand": b, "number": number} for b in brands],
        "fits": list(fits.values()),
    })
json.dump(out, sys.stdout, ensure_ascii=False)
print(f"{len(out)} parts, {sum(len(x['fits']) for x in out)} fits", file=sys.stderr)
