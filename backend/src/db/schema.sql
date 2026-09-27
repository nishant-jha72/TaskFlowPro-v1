-- Schema definition for TaskFlow Pro
-- Core tables

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS projects (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tasks (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'not_started',
  start_date DATE,
  end_date DATE,
  duration INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0
);

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE 1: user_dependencies
-- Stores CONFIRMED per-user task dependency edges.
-- Each user owns their own dependency graph — no cross-user leakage.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_dependencies (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  confirmed BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, task_id, depends_on_task_id),
  CONSTRAINT no_self_dep CHECK (task_id <> depends_on_task_id)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE 2: master_dependencies
-- Platform-wide dependency concept pattern store.
-- Used by the matching algorithm to suggest dependencies to new users.
-- Grows from all confirmed user dependencies (anonymised by concept).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS master_dependencies (
  id SERIAL PRIMARY KEY,
  source_concept TEXT NOT NULL,         -- concept of the DEPENDENT task (e.g. "auth")
  target_concept TEXT NOT NULL,         -- concept of the PREREQUISITE task (e.g. "schema")
  match_score REAL NOT NULL DEFAULT 1.0,
  usage_count INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source_concept, target_concept)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE 3: user_dependency_relations
-- Relational tracking table: user ↔ master_dependency ↔ tasks.
-- Tracks every suggestion shown to a user and whether they accepted/rejected.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_dependency_relations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  master_dependency_id INTEGER REFERENCES master_dependencies(id) ON DELETE SET NULL,
  task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  dep_task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  task_title TEXT,
  dep_task_title TEXT,
  reasoning TEXT,
  source TEXT NOT NULL DEFAULT 'kb',  -- 'kb' | 'llm'
  accepted BOOLEAN DEFAULT NULL,       -- null=pending, true=confirmed, false=rejected
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE 4: user_task_preferences
-- Stores user's preferred column sort position for each task (drag reordering).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_task_preferences (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  col_position INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, task_id)
);

-- Legacy tables kept for backward compat (pattern KB system)
CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_task_id),
  CONSTRAINT no_self_dependency CHECK (task_id <> depends_on_task_id)
);

CREATE TABLE IF NOT EXISTS dependency_patterns (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  source_concept TEXT NOT NULL,
  target_concept TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  accepted_count INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ai_suggestions (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  payload JSONB NOT NULL,
  accepted BOOLEAN DEFAULT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
