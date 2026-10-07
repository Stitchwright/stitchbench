"""
Fill the model keys that the reference data is missing.

`prisma/seed-data/tension_specs.json` and `factory_settings.json` carry `modelKeys` (uppercase letters and digits, as
`modelKey()` in src/lib/format.ts makes them), and every lookup matches on them. The first build of those files only
made keys for model names containing a digit, so rows for "Designer Diamond", "Jewel" or Tajima "TFMX" had none and
could never be found; a note in brackets ("Designer Diamond (also filed as 2009-09 edition)") became junk keys
(ALSOFILEDAS200909EDITION, 200909).

This fills keys from each row's `models` text where the row has none, and removes junk keys made from bracketed
notes. Rows whose keys are all good are left exactly as they are; all-digit model numbers ("770", "221") are good keys.
Generic rows ("All ZSK models", "Generic domestic machines") get no keys: they aren't one model. A name equal to the
brand ("Lame attachment (Tajima)") isn't a model key. Run after regenerating either file, then `npm run db:seed`.

  python scripts/library/fill_model_keys.py [--dry-run]
"""
import json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FILES = ["prisma/seed-data/tension_specs.json", "prisma/seed-data/factory_settings.json"]

# Words that mark a bracketed part as a note rather than another name for the model.
NOTE_WORDS = re.compile(r"\b(also|filed|edition|general|standard|database|knowledge|monitor|made|attachment|models?|"
                        r"series|course|without|marks|most|makes|older|newer|early|late|version|see|page|manual)\b", re.I)
# Trailing words that describe the machine, not name it.
TAIL_WORDS = re.compile(r"\s+(heads?|multihead|machines?|dual function|tubular|automatic|zigzag|general|series)\b.*$", re.I)
GENERIC = re.compile(r"^\s*(all\b|generic\b|any\b|most\b)", re.I)
JUNK_KEY = re.compile(r"^(ALSO|SEE)|EDITION$")
BRACKETS = re.compile(r"\(([^)]*)\)")
ONLY_DIGITS = re.compile(r"[\d\s./-]+")


def key(s):
    return re.sub(r"[^A-Z0-9]", "", (s or "").upper())


def is_note(inner):
    return bool(NOTE_WORDS.search(inner)) or bool(ONLY_DIGITS.fullmatch(inner))


def note_digits(models):
    """Digit runs that appear inside a bracketed note: "(also filed as 2009-09 edition)" gives 200909."""
    out = set()
    for inner in BRACKETS.findall(models or ""):
        if is_note(inner):
            d = re.sub(r"[^0-9]", "", inner)
            if d:
                out.add(d)
    return out


def keys_for(models, brand=""):
    if not models or GENERIC.match(models) or re.search(r"\(general\)", models, re.I):
        return []
    names = []
    for inner in BRACKETS.findall(models):
        if inner.strip() and not is_note(inner):
            names += re.split(r"\s*(?:,|/|;|\band\b)\s*", inner)
    main = BRACKETS.sub(" ", models)
    for part in re.split(r"\s*(?:,|/|;|\+|\band\b)\s*", main):
        names.append(TAIL_WORDS.sub("", part).strip())
    bk = key(brand)
    out = []
    for n in names:
        k = key(n)
        if len(k) >= 3 and k != bk and k not in out:
            out.append(k)
    return out


def main():
    dry = "--dry-run" in sys.argv
    for rel in FILES:
        path = os.path.join(ROOT, rel)
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        rows = json.loads(text)
        # Real \uXXXX escapes in the file (not an escaped backslash followed by "u", as in a Windows path).
        ascii_only = re.search(r"(?<!\\)\\u[0-9a-fA-F]{4}", text) is not None
        filled = fixed = still_empty = 0
        for r in rows:
            ks = r.get("modelKeys") or []
            nd = note_digits(r.get("models", ""))
            junk = [k for k in ks if JUNK_KEY.search(k) or k in nd]
            if ks and not junk:
                continue
            good = [k for k in ks if k not in junk]
            new = good + [k for k in keys_for(r.get("models", ""), r.get("brand", "")) if k not in good]
            if new == ks:
                continue
            if ks:
                fixed += 1
            elif new:
                filled += 1
            if not new:
                still_empty += 1
            r["modelKeys"] = new
        print(f"{rel}: {filled} rows given keys, {fixed} rows' junk keys replaced, {still_empty} still without keys")
        if not dry:
            with open(path, "w", encoding="utf-8", newline="\n") as fh:
                # The files' own format: one key per line, no indent, no final newline.
                json.dump(rows, fh, ensure_ascii=ascii_only, indent=0)


if __name__ == "__main__":
    main()
