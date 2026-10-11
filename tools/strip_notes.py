"""Remove the reviewers' notes ([LAWYER: ...] and [OWNER: ...], which may span lines and hold brackets) from
markdown files in place. Placeholders such as [OWNER LEGAL NAME] have no colon and are left alone.

usage: python3 -I strip_notes.py FILE...
"""
import re
import sys

NOTE = re.compile(r"\[(?:LAWYER|OWNER)(?:/(?:LAWYER|OWNER))*:")
# The draft banner's lines that explain the notes ("> Notes in `[LAWYER: ...]` are questions for the lawyer...").
EXPLAINER = re.compile(r"^> Notes in `\[LAWYER: \.\.\.\]`.*?(?=^(?!>)|\Z)", re.M | re.S)


def strip(text: str) -> tuple[str, int, bool]:
    text = EXPLAINER.sub("", text)
    spans, i, unclosed = [], 0, False
    while m := NOTE.search(text, i):
        s, depth, e = m.start(), 0, None
        for j in range(s, len(text)):
            if text[j] == "[":
                depth += 1
            elif text[j] == "]":
                depth -= 1
                if depth == 0:
                    e = j + 1
                    break
        if e is None:  # never guess where an unclosed note ends
            unclosed = True
            break
        ls = text.rfind("\n", 0, s) + 1  # start of the note's first line
        le = text.find("\n", e)
        le = len(text) if le == -1 else le  # end of its last line
        blank_before = text[ls:s].strip(" \t") == ""
        blank_after = text[e:le].strip(" \t") == ""
        if blank_before and blank_after:  # a note on lines of its own: the lines go
            spans.append((ls, min(le + 1, len(text))))
        elif blank_before:  # at the start of a line of text: the spaces after it go too
            k = e
            while k < le and text[k] in " \t":
                k += 1
            spans.append((s, k))
        else:  # inside a sentence: the spaces before it go
            k = s
            while k > ls and text[k - 1] in " \t":
                k -= 1
            spans.append((k, e))
        i = e
    out, prev = [], 0
    for a, b in spans:
        out.append(text[prev:a] if a > prev else "")
        prev = max(prev, b)
    out.append(text[prev:])
    return re.sub(r"\n{3,}", "\n\n", "".join(out)), len(spans), unclosed


if __name__ == "__main__":
    failed = False
    for path in sys.argv[1:]:
        with open(path, encoding="utf-8") as f:
            new, n, unclosed = strip(f.read())
        with open(path, "w", encoding="utf-8") as f:
            f.write(new)
        left = len(NOTE.findall(new))
        print(f"  {path}: {n} notes removed" + (f", {left} left (unclosed?)" if left or unclosed else ""))
        failed |= bool(left or unclosed)
    sys.exit(1 if failed else 0)
