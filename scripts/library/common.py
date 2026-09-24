r"""Shared helpers for the in-house library scripts (run on the shop PC that holds C:\Manuals)."""
import hashlib, os, re

LIB = os.environ.get("MANUALS_ROOT", r"C:\Manuals")
MEDIA = os.environ.get("STITCHBENCH_MEDIA", os.path.join(os.path.expanduser("~"), "stitchbench-media"))
MACHINE_CATS = ("Sewing", "Embroidery", "Longarm", "Industrial-Sewing")


def model_keys(text: str, path: str = "") -> list[str]:
    """Normalized model tokens (letters+digits, must contain a digit), from a model string and a Brand_Model_ file name."""
    toks = set()
    for part in re.split(r"[,/+;()]|\band\b|\s-\s", text or ""):
        k = re.sub(r"[^A-Z0-9]", "", part.upper())
        if re.search(r"\d", k) and 2 <= len(k) <= 24:
            toks.add(k)
        for w in re.findall(r"[A-Za-z]*\d[\w-]*", part):
            k2 = re.sub(r"[^A-Z0-9]", "", w.upper())
            if 2 <= len(k2) <= 24:
                toks.add(k2)
    base = os.path.basename(path)
    m = re.match(r"[^_]+_([^_]+)_", base)
    if m:
        for part in m.group(1).split("+"):
            k = re.sub(r"[^A-Z0-9]", "", part.upper())
            if re.search(r"\d", k) and 2 <= len(k) <= 24:
                toks.add(k)
    return sorted(toks)


def file_models(path: str) -> str:
    """Model segment of Brand_Model_DocType.pdf, else the file name without extension."""
    base = os.path.basename(path)
    m = re.match(r"[^_]+_([^_]+)_", base)
    if m:
        return m.group(1).replace("+", ", ")
    return os.path.splitext(base)[0]


DOC_TYPES = ["ServiceManual", "TechnicalManual", "MaintenanceManual", "PartsList", "OperatorManual", "ErrorCodes",
             "WiringDiagram", "Schematic", "Firmware", "Training", "Bulletin"]


def doc_type(path: str) -> str | None:
    b = os.path.basename(path)
    for t in DOC_TYPES:
        if t.lower() in b.lower():
            return t
    low = b.lower()
    if re.search(r"parts?\b|parts list|parts book|catalog", low): return "PartsList"
    if re.search(r"service|repair|adjust|engineer|technical", low): return "ServiceManual"
    if re.search(r"instruction|operat|owner|user|manual", low): return "OperatorManual"
    if "brochure" in low: return "Brochure"
    return None


def figure_id(source_path: str, page: int, box) -> str:
    """Must match figureId() in src/lib/figures.ts."""
    key = f"{source_path}|{page}|{','.join(fmt(b) for b in box)}"
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:24]


def fmt(x: float) -> str:
    s = repr(round(float(x), 3))
    return s[:-2] if s.endswith(".0") else s
