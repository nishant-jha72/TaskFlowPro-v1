/**
 * PostgreSQL Data Access Layer & Pool Client
 */

const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");
const { memoryStore } = require("./index");

const connectionString =
  process.env.DATABASE_URL ||
  "postgresql://nishant:Nishant123@localhost:5432/taskflowpro";

const pool = new Pool({
  connectionString,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

let isPgConnected = false;

async function initPgDatabase() {
  try {
    const client = await pool.connect();
    console.log("Successfully connected to PostgreSQL database!");
    isPgConnected = true;

    // Run full schema — creates all tables including new ones
    const schemaSql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
    await client.query(schemaSql);
    console.log("Schema applied (all tables ready)");

    // Run recommendation system schema migration (pgvector, pg_trgm, canonical tasks & patterns)
    const recSchemaPath = path.join(__dirname, "migrations", "001_dependency_recommendation_schema.sql");
    if (fs.existsSync(recSchemaPath)) {
      const recSchemaSql = fs.readFileSync(recSchemaPath, "utf8");
      await client.query(recSchemaSql);
      console.log("Recommendation schema migration applied (pgvector & pg_trgm tables ready)");
    }

    // Seed data only if users table is empty
    const userRes = await client.query("SELECT COUNT(*) FROM users");
    if (parseInt(userRes.rows[0].count, 10) === 0) {
      console.log("Migrating seed data into PostgreSQL...");

      for (const u of memoryStore.users) {
        await client.query(
          "INSERT INTO users (id, name, email, password_hash) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING",
          [u.id, u.name, u.email, u.password_hash]
        );
      }
      await client.query("SELECT setval('users_id_seq', (SELECT COALESCE(MAX(id),1) FROM users))");

      for (const p of memoryStore.projects) {
        await client.query(
          "INSERT INTO projects (id, user_id, title, description) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING",
          [p.id, p.user_id, p.title, p.description]
        );
      }
      await client.query("SELECT setval('projects_id_seq', (SELECT COALESCE(MAX(id),1) FROM projects))");

      for (const t of memoryStore.tasks) {
        await client.query(
          `INSERT INTO tasks (id, project_id, title, description, status, start_date, end_date, duration, position)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
          [t.id, t.project_id, t.title, t.description, t.status, t.start_date, t.end_date, t.duration, t.position]
        );
      }
      await client.query("SELECT setval('tasks_id_seq', (SELECT COALESCE(MAX(id),1) FROM tasks))");

      // TABLE 1: user_dependencies
      for (const d of (memoryStore.user_dependencies || [])) {
        await client.query(
          "INSERT INTO user_dependencies (id, user_id, task_id, depends_on_task_id, confirmed) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
          [d.id, d.user_id, d.task_id, d.depends_on_task_id, d.confirmed]
        );
      }

      // TABLE 2: master_dependencies
      for (const m of (memoryStore.master_dependencies || [])) {
        await client.query(
          "INSERT INTO master_dependencies (id, source_concept, target_concept, match_score, usage_count) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
          [m.id, m.source_concept, m.target_concept, m.match_score, m.usage_count]
        );
      }

      console.log("PostgreSQL seed migration complete!");
    }

    client.release();
  } catch (err) {
    console.warn("PostgreSQL connection fallback:", err.message);
    console.warn("Running with persistent JSON file store.");
    isPgConnected = false;
  }
}

async function query(text, params) {
  if (isPgConnected) return pool.query(text, params);
  return null;
}

module.exports = {
  pool,
  query,
  initPgDatabase,
  get isPgConnected() { return isPgConnected; }
};
