r"""Supplier index for the community parts cross-reference: where each part number is sold, with the price when the
store publishes it in a machine-readable feed. Facts only (part number, product link, price); never descriptions or
images. Obeys robots.txt, identifies itself, and paces every site (Crawl-delay honoured).

Sources (checked 2026-09-25):
  sewingpartsonline.com, gromes.com, sewingmachinesplus.com : Shopify /products.json (250 products per request: SKU + price)
  premierstitching.com, allbrands.com, brother-usa.com       : product sitemaps (part number in the product URL; no price)
  Skipped on purpose: sewmanyparts.com (blocks AI crawlers by name), wawak (blocks robots), janome.com (firewall).

usage: python scripts/hub/scrape_suppliers.py <out dir> [vendor ...]   -> <out dir>/<vendor>.jsonl
Each line: {"vendor", "raw" (SKU/slug token as the store prints it), "url", "priceCents" (or null), "title"}.
The title is kept only to match part numbers later; it is not published."""
import gzip
import io
import json
import os
import re
import sys
import time
import urllib.request
import urllib.robotparser
import xml.etree.ElementTree as ET

UA = "StitchHub-SupplierIndex/1.0 (+https://github.com/bwattendorf/stitchhub; repair-shop parts cross-reference)"
OUT = sys.argv[1] if len(sys.argv) > 1 else "suppliers"
ONLY = set(sys.argv[2:])
os.makedirs(OUT, exist_ok=True)

_robots = {}
_last = {}


def allowed(url):
    host = url.split("/")[2]
    rp = _robots.get(host)
    if rp is None:
        rp = urllib.robotparser.RobotFileParser()
        rp.set_url(f"https://{host}/robots.txt")
        try:
            req = urllib.request.Request(f"https://{host}/robots.txt", headers={"User-Agent": UA})
            rp.parse(urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "replace").splitlines())
        except Exception:
            rp.parse([])
        _robots[host] = rp
    return rp.can_fetch(UA, url), rp.crawl_delay(UA)


def get(url, delay):
    ok, crawl = allowed(url)
    if not ok:
        raise PermissionError(f"robots.txt disallows {url}")
    host = url.split("/")[2]
    wait = max(delay, crawl or 0) - (time.time() - _last.get(host, 0))
    if wait > 0:
        time.sleep(wait)
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json, text/xml, */*"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
                _last[host] = time.time()
                if url.endswith(".gz") or r.headers.get("Content-Encoding") == "gzip":
                    data = gzip.decompress(data)
                return data
        except urllib.error.HTTPError as e:
            _last[host] = time.time()
            if e.code in (429, 503) and attempt < 2:
                time.sleep(30 * (attempt + 1))
                continue
            raise
    return b""


def shopify(vendor, base, delay=2.5):
    """All products via /products.json (robots-allowed on these stores): SKU and price per variant."""
    out = open(os.path.join(OUT, f"{vendor}.jsonl"), "w", encoding="utf-8")
    n = 0
    for page in range(1, 1000):
        try:
            d = json.loads(get(f"{base}/products.json?limit=250&page={page}", delay))
        except PermissionError as e:
            print(vendor, e)
            break
        prods = d.get("products") or []
        if not prods:
            break
        for p in prods:
            url = f"{base}/products/{p.get('handle')}"
            for v in p.get("variants") or []:
                price = v.get("price")
                row = {
                    "vendor": vendor,
                    "raw": (v.get("sku") or "").strip(),
                    "url": url,
                    "priceCents": round(float(price) * 100) if price not in (None, "") else None,
                    "title": p.get("title"),
                    "handle": p.get("handle"),
                }
                out.write(json.dumps(row, ensure_ascii=False) + "\n")
                n += 1
        print(f"{vendor}: page {page}, {n} variants", flush=True)
    out.close()
    return n


def sitemap_urls(url, delay, depth=0):
    """Every <loc> in a sitemap or sitemap index (follows nested indexes)."""
    try:
        root = ET.fromstring(get(url, delay))
    except Exception as e:
        print("sitemap", url, e, flush=True)
        return []
    ns = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9"}
    locs = [e.text.strip() for e in root.findall(".//s:loc", ns) if e.text]
    if root.tag.endswith("sitemapindex") and depth < 2:
        out = []
        for loc in locs:
            out += sitemap_urls(loc, delay, depth + 1)
        return out
    return locs


def sitemap_vendor(vendor, index, keep, delay):
    out = open(os.path.join(OUT, f"{vendor}.jsonl"), "w", encoding="utf-8")
    n = 0
    for url in sitemap_urls(index, delay):
        if not keep(url):
            continue
        slug = url.rstrip("/").split("/")[-1].split("?")[0]
        out.write(json.dumps({"vendor": vendor, "raw": slug, "url": url, "priceCents": None, "title": None}) + "\n")
        n += 1
    out.close()
    print(f"{vendor}: {n} product URLs", flush=True)
    return n


VENDORS = {
    "sewingpartsonline": lambda: shopify("sewingpartsonline", "https://www.sewingpartsonline.com"),
    "gromes": lambda: shopify("gromes", "https://www.gromes.com"),
    "sewingmachinesplus": lambda: shopify("sewingmachinesplus", "https://www.sewingmachinesplus.com"),
    "premierstitching": lambda: sitemap_vendor(
        "premierstitching", "https://www.premierstitching.com/xmlsitemap.php?type=products&page=1", lambda u: True, 10
    ),
    "allbrands": lambda: sitemap_vendor("allbrands", "https://www.allbrands.com/sitemap.xml", lambda u: "/products/" in u, 3),
    "brother-usa": lambda: sitemap_vendor("brother-usa", "https://www.brother-usa.com/sitemap_product_0.xml", lambda u: "/p/" in u, 3),
}

if __name__ == "__main__":
    for name, run in VENDORS.items():
        if ONLY and name not in ONLY:
            continue
        t = time.time()
        try:
            n = run()
            print(f"== {name}: {n} rows in {time.time() - t:.0f}s", flush=True)
        except Exception as e:
            print(f"== {name}: failed: {e!r}", flush=True)
