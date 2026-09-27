/**
 * Persistent Store Layer — JSON disk store + PostgreSQL
 * Manages: users, projects, tasks, user_dependencies (per-user),
 *          master_dependencies (platform KB), user_dependency_relations (tracking),
 *          user_task_preferences (drag positions), dependency_patterns, ai_suggestions
 */

const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'db_data.json');

const defaultSeed = {
  users: [
    { id: 1, name: 'Demo Lead', email: 'lead@taskflow.pro', password_hash: '$2a$10$w3bH7Q/q1N2v.rTz1e2U3.kK5w5u/Y3r8m8.E5m5' }
  ],
  projects: [
    { id: 1, user_id: 1, title: 'Payment Gateway Integration', description: 'Engineering task board' }
  ],
  tasks: [
    { id: 1, project_id: 1, title: 'Design Database Schema', status: 'done',        start_date: '2026-09-20', end_date: '2026-09-22', duration: 2, position: 0 },
    { id: 2, project_id: 1, title: 'Implement Auth Endpoint', status: 'ready',       start_date: '2026-09-22', end_date: '2026-09-24', duration: 2, position: 1 },
    { id: 3, project_id: 1, title: 'Build Stripe Webhook',    status: 'blocked',     start_date: '2026-09-24', end_date: '2026-09-27', duration: 3, position: 2 },
    { id: 4, project_id: 1, title: 'Frontend Checkout Form',  status: 'blocked',     start_date: '2026-09-24', end_date: '2026-09-26', duration: 2, position: 3 },
    { id: 5, project_id: 1, title: 'End-to-End E2E Tests',    status: 'blocked',     start_date: '2026-09-27', end_date: '2026-09-29', duration: 2, position: 4 }
  ],

  // TABLE 1: Per-user confirmed dependency edges (replaces global task_dependencies for user graphs)
  user_dependencies: [
    { id: 1, user_id: 1, task_id: 2, depends_on_task_id: 1, confirmed: true },
    { id: 2, user_id: 1, task_id: 3, depends_on_task_id: 2, confirmed: true },
    { id: 3, user_id: 1, task_id: 4, depends_on_task_id: 2, confirmed: true },
    { id: 4, user_id: 1, task_id: 5, depends_on_task_id: 3, confirmed: true },
    { id: 5, user_id: 1, task_id: 5, depends_on_task_id: 4, confirmed: true }
  ],

  // TABLE 2: Platform-wide master concept KB for matching algorithm
  master_dependencies: [
    { id: 1, source_concept: 'auth',    target_concept: 'schema',  match_score: 1.0, usage_count: 5 },
    { id: 2, source_concept: 'api',     target_concept: 'schema',  match_score: 1.0, usage_count: 8 },
    { id: 3, source_concept: 'test',    target_concept: 'api',     match_score: 1.0, usage_count: 4 },
    { id: 4, source_concept: 'webhook', target_concept: 'auth',    match_score: 0.9, usage_count: 3 },
    { id: 5, source_concept: 'deploy',  target_concept: 'test',    match_score: 0.9, usage_count: 3 },
    { id: 6, source_concept: 'frontend',target_concept: 'api',     match_score: 0.85, usage_count: 6 },
    { id: 7, source_concept: 'ui',      target_concept: 'api',     match_score: 0.85, usage_count: 4 },
    { id: 8, source_concept: 'payment', target_concept: 'auth',    match_score: 0.8, usage_count: 2 }
  ],

  // TABLE 3: Relational tracking — user ↔ suggestion ↔ master_dependency
  user_dependency_relations: [],

  // TABLE 4: User-specific column drag positions
  user_task_preferences: [
    { user_id: 1, task_id: 1, col_position: 0 },
    { user_id: 1, task_id: 2, col_position: 0 },
    { user_id: 1, task_id: 3, col_position: 0 },
    { user_id: 1, task_id: 4, col_position: 1 },
    { user_id: 1, task_id: 5, col_position: 0 }
  ],

  // Legacy: kept for backward compat
  task_dependencies: [
    { task_id: 2, depends_on_task_id: 1 },
    { task_id: 3, depends_on_task_id: 2 },
    { task_id: 4, depends_on_task_id: 2 },
    { task_id: 5, depends_on_task_id: 3 },
    { task_id: 5, depends_on_task_id: 4 }
  ],
  dependency_patterns: [
    { id: 1, user_id: 1, source_concept: 'auth',    target_concept: 'schema', confidence: 1.0, accepted_count: 5 },
    { id: 2, user_id: 1, source_concept: 'api',     target_concept: 'schema', confidence: 1.0, accepted_count: 8 },
    { id: 3, user_id: 1, source_concept: 'test',    target_concept: 'api',    confidence: 1.0, accepted_count: 4 }
  ],
  ai_suggestions: []
};

let memoryStore;
try {
  if (fs.existsSync(DB_FILE)) {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    // Merge new tables into old on-disk stores if missing
    memoryStore = {
      ...defaultSeed,
      ...parsed,
      user_dependencies:         parsed.user_dependencies         || defaultSeed.user_dependencies,
      master_dependencies:       parsed.master_dependencies       || defaultSeed.master_dependencies,
      user_dependency_relations: parsed.user_dependency_relations || [],
      user_task_preferences:     parsed.user_task_preferences     || defaultSeed.user_task_preferences
    };
  } else {
    memoryStore = defaultSeed;
    fs.writeFileSync(DB_FILE, JSON.stringify(memoryStore, null, 2));
  }
} catch (err) {
  console.error('Error loading DB file, using seed:', err.message);
  memoryStore = defaultSeed;
}

const safeMax = (arr) => (arr.length === 0 ? 0 : Math.max(...arr));

let nextIds = {
  users:                     safeMax(memoryStore.users.map(u => u.id)) + 1,
  projects:                  safeMax(memoryStore.projects.map(p => p.id)) + 1,
  tasks:                     safeMax(memoryStore.tasks.map(t => t.id)) + 1,
  user_dependencies:         safeMax((memoryStore.user_dependencies || []).map(d => d.id)) + 1,
  master_dependencies:       safeMax((memoryStore.master_dependencies || []).map(d => d.id)) + 1,
  user_dependency_relations: safeMax((memoryStore.user_dependency_relations || []).map(r => r.id)) + 1,
  dependency_patterns:       safeMax(memoryStore.dependency_patterns.map(p => p.id)) + 1,
  ai_suggestions:            safeMax(memoryStore.ai_suggestions.map(s => s.id)) + 1
};

function saveToDisk() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(memoryStore, null, 2));
  } catch (err) {
    console.error('Failed writing DB to disk:', err.message);
  }
}

module.exports = { memoryStore, nextIds, saveToDisk };
