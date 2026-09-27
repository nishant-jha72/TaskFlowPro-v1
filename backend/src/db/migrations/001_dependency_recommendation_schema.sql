-- Database Migration: Task Dependency Recommendation System
-- Enables pgvector and pg_trgm, creates tables, enums, indexes, and triggers

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 1. Canonical Tasks
CREATE TABLE IF NOT EXISTS canonical_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name TEXT UNIQUE NOT NULL,
  embedding vector(384),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Task Aliases
CREATE TABLE IF NOT EXISTS task_aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_task_id UUID NOT NULL REFERENCES canonical_tasks(id) ON DELETE CASCADE,
  alias_text TEXT NOT NULL,
  alias_text_normalized TEXT NOT NULL,
  embedding vector(384),
  confidence_score DOUBLE PRECISION DEFAULT 1.0,
  source TEXT NOT NULL CHECK (source IN ('fuzzy_match', 'embedding_match', 'llm_suggested', 'user_confirmed')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. Task Dependencies (User level)
-- Rename legacy task_dependencies if present as non-UUID
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'task_dependencies' AND data_type = 'integer' AND column_name = 'task_id'
  ) THEN
    ALTER TABLE task_dependencies RENAME TO legacy_task_dependencies;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS task_dependencies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES canonical_tasks(id) ON DELETE CASCADE,
  depends_on_task_id UUID NOT NULL REFERENCES canonical_tasks(id) ON DELETE CASCADE,
  sequence_order INTEGER DEFAULT 1,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT no_self_dep_recommendation CHECK (task_id <> depends_on_task_id)
);

-- 4. Dependency Patterns (Aggregated / Precomputed)
-- Rename legacy dependency_patterns if present with text concept columns
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'dependency_patterns' AND column_name = 'source_concept'
  ) THEN
    ALTER TABLE dependency_patterns RENAME TO legacy_dependency_patterns;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS dependency_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES canonical_tasks(id) ON DELETE CASCADE,
  depends_on_task_id UUID NOT NULL REFERENCES canonical_tasks(id) ON DELETE CASCADE,
  frequency_count INTEGER NOT NULL DEFAULT 1,
  confidence DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  last_updated TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(task_id, depends_on_task_id),
  CONSTRAINT no_self_pattern CHECK (task_id <> depends_on_task_id)
);

-- 5. Resolution Logs (Auditing & Threshold Tuning)
CREATE TABLE IF NOT EXISTS resolution_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  input_text TEXT NOT NULL,
  resolved_canonical_task_id UUID REFERENCES canonical_tasks(id) ON DELETE SET NULL,
  layer TEXT NOT NULL, -- 'fuzzy_match', 'embedding_match', 'llm_fallback', 'no_match'
  similarity_score DOUBLE PRECISION,
  reasoning TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance & vector search

-- HNSW index for pgvector nearest neighbor search (cosine distance)
CREATE INDEX IF NOT EXISTS idx_canonical_tasks_embedding ON canonical_tasks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_task_aliases_embedding ON task_aliases USING hnsw (embedding vector_cosine_ops);

-- Trigram index for Layer 1 fuzzy matching
CREATE INDEX IF NOT EXISTS idx_task_aliases_normalized_trgm ON task_aliases USING gin (alias_text_normalized gin_trgm_ops);

-- Foreign key & query lookup indexes
CREATE INDEX IF NOT EXISTS idx_task_aliases_canonical_id ON task_aliases(canonical_task_id);
CREATE INDEX IF NOT EXISTS idx_dependency_patterns_task_id ON dependency_patterns(task_id);
CREATE INDEX IF NOT EXISTS idx_dependency_patterns_depends_on ON dependency_patterns(depends_on_task_id);
CREATE INDEX IF NOT EXISTS idx_task_dependencies_user ON task_dependencies(user_id);
