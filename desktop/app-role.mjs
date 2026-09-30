// The database login the web server uses: stitchbench_app, an ordinary role that can read and write the shop's tables
// and nothing more. The role the program itself connects with (the one initdb made, "stitchbench") is the cluster's
// superuser: it owns every table and is kept for the program's own work in main.mjs (updates, backups, restores, the
// shipped reference data). The server facing the shop network never gets it, so a future injection bug in a page
// could at worst change data, not run programs on the PC (COPY ... TO PROGRAM, pg_read_file and the like are refused).
//
// ensureAppRole runs as the superuser on every start, after the migrations, and after a restore. It is safe to repeat:
// it creates the role if missing, sets its password to the one in secrets.json every time (a secrets.json put back
// from an old copy, or a role made by hand, can't lock the server out: the password on file always wins), and grants
// what the server needs on the tables that exist now plus, through default privileges, on any the next update makes.
const ROLE = "stitchbench_app";
const NAME = /^[a-z_][a-z0-9_]*$/;

/**
 * Make sure the server's role exists with this password and can use every table in the connected database.
 * pool: the superuser's, connected to the shop database. Returns the role name.
 */
export async function ensureAppRole(pool, { password, role = ROLE, log = console.log } = {}) {
  if (!password) throw new Error("The app database role needs a password.");
  if (!NAME.test(role)) throw new Error(`Bad database role name: ${role}`);
  const lit = `'${String(password).replace(/'/g, "''")}'`;
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [role]);
    if (!rows.length) {
      await client.query(`CREATE ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD ${lit}`);
      log(`database: created the server's login ${role}`);
    }
    // Every time: a role made by an older version, by hand, or with a password no longer on file gets the settings
    // and the password this program has. (The password is hashed by Postgres before it is stored.)
    await client.query(`ALTER ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD ${lit}`);
    const { rows: dbs } = await client.query(`SELECT current_database() AS db`);
    const db = `"${dbs[0].db.replace(/"/g, '""')}"`;
    await client.query(`GRANT CONNECT, TEMPORARY ON DATABASE ${db} TO ${role}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    // What exists now (tables made by the migrations that have run, and any sequence)...
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await client.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    // ...and whatever the connected user (the superuser that runs the migrations) makes later, so a table from the
    // next update works even before this runs again.
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${role}`);
    return role;
  } finally {
    client.release();
  }
}

export const APP_ROLE = ROLE;
