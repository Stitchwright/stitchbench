r"""Match the supplier index (scrape_suppliers.py output) to part numbers in the cross-reference and write the
hub's bulk "where to buy" import. Only exact part-number matches count (after removing dashes, spaces and each
store's own prefixes); a row whose candidates hit more than one different part is dropped as ambiguous.
usage: python scripts/hub/match_suppliers.py <suppliers dir> <xparts.json or .jsonl> [more ...] > sources.json"""
import glob
import json
import os
import re
import sys

VENDOR = {
    "sewingpartsonline": "Sewing Parts Online",
    "gromes": "Grome's",
    "sewingmachinesplus": "Sewing Machines Plus",
    "premierstitching": "Premier Stitching",
    "allbrands": "AllBrands",
    "brother-usa": "Brother USA",
}


def key(s):
    return re.sub(r"[^A-Z0-9]", "", str(s).upper())


def load_numbers(paths):
    """number key -> printed number (from the cross-reference seed or the deep extraction)."""
    nums = {}
    for p in paths:
        if p.endswith(".jsonl"):
            rows = (json.loads(l) for l in open(p, encoding="utf-8") if l.strip())
            for r in rows:
                k = key(r["number"])
                if len(k) >= 5:
                    nums.setdefault(k, r["number"])
        else:
            for x in json.load(open(p, encoding="utf-8")):
                for n in x["numbers"]:
                    k = key(n["number"])
                    if len(k) >= 5:
                        nums.setdefault(k, n["number"])
    return nums


def candidates(row):
    """Part-number keys a supplier row could be for."""
    texts = [row.get("raw") or "", row.get("handle") or "", row["url"].rstrip("/").split("/")[-1].split("?")[0]]
    if row.get("title"):
        texts.append(row["title"])
    out = set()
    for t in texts:
        toks = [x for x in re.split(r"[\s/_.,()#:]+", t) if x]
        for tok in toks:
            parts = tok.split("-")
            # whole token, each dash part, and runs of adjacent dash parts ("868-817-002" -> 868817002)
            for i in range(len(parts)):
                for j in range(i + 1, min(len(parts), i + 4) + 1):
                    k = key("".join(parts[i:j]))
                    if 5 <= len(k) <= 16 and re.search(r"\d", k):
                        out.add(k)
    # store prefixes: Sewing Parts Online "Z360501001" (Janome), Sewing Machines Plus "tacony-..."
    for k in list(out):
        if k.startswith("Z") and k[1:].isdigit():
            out.add(k[1:])
    return out


def main():
    sup_dir, *num_paths = sys.argv[1:]
    nums = load_numbers(num_paths)
    out, seen, stats = [], set(), {}
    for f in sorted(glob.glob(os.path.join(sup_dir, "*.jsonl"))):
        vendor = os.path.basename(f)[:-6]
        hit = amb = total = 0
        for line in open(f, encoding="utf-8"):
            if not line.strip():
                continue
            total += 1
            row = json.loads(line)
            matches = {k for k in candidates(row) if k in nums}
            if not matches:
                continue
            # a longer key inside a shorter one (e.g. 797010303 vs 97010303) is one part; different parts = ambiguous
            best = sorted(matches, key=len, reverse=True)
            distinct = [k for k in best if not any(k != o and k in o for o in best)]
            if len(distinct) > 1:
                amb += 1
                continue
            k = distinct[0]
            if (k, row["url"]) in seen:
                continue
            seen.add((k, row["url"]))
            price = row.get("priceCents")
            out.append({"number": nums[k], "vendor": VENDOR.get(vendor, vendor), "url": row["url"], "priceCents": price if price and price > 0 else None})
            hit += 1
        stats[vendor] = {"rows": total, "matched": hit, "ambiguous": amb}
    json.dump(out, sys.stdout, ensure_ascii=False)
    print(json.dumps(stats, indent=1), file=sys.stderr)
    print(f"{len(out)} sources for {len({o['number'] for o in out})} part numbers", file=sys.stderr)


if __name__ == "__main__":
    main()
