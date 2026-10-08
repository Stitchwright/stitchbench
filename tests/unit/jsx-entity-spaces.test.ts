// The compiler drops the leading space of a JSX text that holds an entity (&apos;, &quot;...) and runs onto the next
// line: "{money(total)} with today&apos;s tax." + a line break rendered "$551.20with today's tax." Such a text after
// an expression or a tag has to start with {" "} instead (npm run test:unit).
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) return n === "generated" ? [] : tsxFiles(p);
    return p.endsWith(".tsx") ? [p] : [];
  });
}

test("no JSX text loses the space before it", () => {
  const bad: string[] = [];
  for (const file of tsxFiles(path.join(process.cwd(), "src"))) {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      if (ts.isJsxText(node)) {
        const t = node.getFullText();
        const parent = node.parent;
        const kids = ts.isJsxElement(parent) || ts.isJsxFragment(parent) ? parent.children : null;
        const i = kids ? kids.indexOf(node) : -1;
        if (i > 0 && /&[a-zA-Z0-9#]+;/.test(t) && t.includes("\n") && /^[ \t]+\S/.test(t)) {
          bad.push(`${path.relative(process.cwd(), file)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  assert.deepEqual(bad, []);
});
