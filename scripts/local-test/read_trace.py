# Print the slow requests from a Playwright trace (test-results/**/trace.zip): method, url, status, ms, start offset.
import glob, json, sys, zipfile

root = sys.argv[1] if len(sys.argv) > 1 else "C:/Users/bwatt/stitchbench/test-results"
for z in glob.glob(root + "/**/trace.zip", recursive=True):
    print("==", z)
    with zipfile.ZipFile(z) as zf:
        names = [n for n in zf.namelist() if n.endswith(".network")]
        rows = []
        t0 = None
        for n in names:
            for line in zf.read(n).decode("utf-8", "replace").splitlines():
                try:
                    e = json.loads(line)
                except Exception:
                    continue
                if e.get("type") != "resource-snapshot":
                    continue
                s = e["snapshot"]
                st = s.get("startedDateTime")
                url = s["request"]["url"]
                ms = s.get("time", 0)
                t0 = t0 or st
                rows.append((st, s["request"]["method"], url, s["response"].get("status"), round(ms)))
        rows.sort()
        for st, m, url, status, ms in rows:
            if ms >= 2000 or (m == "POST" and "localhost:3300" in url):
                print(f"{st[11:23]} {m:4s} {status!s:4s} {ms:7d} ms  {url[:110]}")
