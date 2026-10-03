// Reference data that ships with the program (prisma/seed-data, copied into the server by prepare-app.mjs): tension
// specs, factory settings, test modes and, for a bench with a manual library, the manual list. A new install gets them on its first
// start and an update brings in a changed set. What was loaded is recorded as the table's comment (seed:<hash>), so an
// unchanged set costs one query per start. Same result as `npm run db:seed` in the repo: the shipped rows, nothing else.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const SETS = [
  { table: "TensionSpec", file: "tension_specs.json" },
  { table: "FactorySetting", file: "factory_settings.json" },
  { table: "ServiceMode", file: "service_modes.json" },
  { table: "LibraryDoc", file: "library_docs.json", needsLibrary: true },
];

export async function loadReference(pool, dir, { library, log }) {
  for (const s of SETS) {
    const file = path.join(dir, s.file);
    if (!fs.existsSync(file) || (s.needsLibrary && !library)) continue;
    const text = fs.readFileSync(file, "utf8");
    const mark = `seed:${crypto.createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
    const t = `"${s.table}"`;
    const client = await pool.connect();
    try {
      const { rows } = await client.query(`SELECT obj_description($1::regclass, 'pg_class') AS c`, [t]);
      if (rows[0]?.c === mark) continue;
      const data = JSON.parse(text);
      if (!Array.isArray(data) || !data.length) continue;
      const cols = (
        await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [s.table])
      ).rows
        .map((r) => r.column_name)
        .filter((c) => c in data[0]);
      const list = cols.map((c) => `"${c}"`).join(", ");
      const update = cols.filter((c) => c !== "id").map((c) => `"${c}" = EXCLUDED."${c}"`).join(", ");
      await client.query("BEGIN");
      await client.query(`DELETE FROM ${t} WHERE NOT (id = ANY($1::text[]))`, [data.map((r) => r.id)]);
      for (let i = 0; i < data.length; i += 2000) {
        await client.query(
          `INSERT INTO ${t} (${list}) SELECT ${list} FROM jsonb_populate_recordset(NULL::${t}, $1::jsonb) ON CONFLICT (id) DO UPDATE SET ${update}`,
          [JSON.stringify(data.slice(i, i + 2000))],
        );
      }
      await client.query(`COMMENT ON TABLE ${t} IS '${mark}'`);
      await client.query("COMMIT");
      log(`reference data: ${s.table} (${data.length} rows) loaded`);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      // Never stops the program: the shop's own data works without it.
      log(`reference data: ${s.table} not loaded:`, e);
    } finally {
      client.release();
    }
  }
}
