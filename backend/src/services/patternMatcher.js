/**
 * DAG Pattern Matcher & Keyword Engine
 * Custom concept extraction, DAG match scoring algorithm (confidence %),
 * and pattern store learning.
 */

const { memoryStore, nextIds } = require('../db');

/**
 * Extended technical stop words list
 */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'in', 'on', 'for', 'to', 'of', 'and', 'or', 'with', 'by', 'at',
  'from', 'into', 'is', 'it', 'this', 'that', 'be', 'are', 'was', 'were', 'will',
  'would', 'should', 'can', 'could', 'has', 'have', 'had', 'create', 'build', 'implement',
  'add', 'make', 'do', 'new', 'task', 'code', 'file', 'setup'
]);

/**
 * Technical domain keyword mapping / normalization dictionary
 */
const CONCEPT_ALIASES = {
  authentication: 'auth',
  authorize: 'auth',
  login: 'auth',
  jwt: 'auth',
  signup: 'auth',
  user: 'auth',
  permission: 'auth',
  role: 'auth',
  database: 'schema',
  db: 'schema',
  table: 'schema',
  model: 'schema',
  migration: 'schema',
  postgres: 'schema',
  sql: 'schema',
  endpoint: 'api',
  rest: 'api',
  route: 'api',
  controller: 'api',
  server: 'api',
  service: 'api',
  interface: 'ui',
  frontend: 'ui',
  component: 'ui',
  view: 'ui',
  page: 'ui',
  dashboard: 'ui',
  modal: 'ui',
  test: 'testing',
  e2e: 'testing',
  unit: 'testing',
  jest: 'testing',
  cypress: 'testing',
  payment: 'stripe',
  checkout: 'stripe',
  subscription: 'stripe',
  billing: 'stripe',
  hook: 'webhook',
  listener: 'webhook',
  notification: 'webhook'
};

/**
 * Extracts normalized master keywords/concepts from text (title + description)
 * 
 * @param {string} title 
 * @param {string} [description] 
 * @returns {Array<string>} Unique list of extracted concept keywords
 */
function extractMasterKeywords(title, description = '') {
  const combined = `${title || ''} ${description || ''}`.toLowerCase();
  const rawTokens = combined
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));

  const concepts = new Set();

  rawTokens.forEach(token => {
    const normalized = CONCEPT_ALIASES[token] || token;
    concepts.add(normalized);
  });

  return Array.from(concepts);
}

/**
 * Custom DAG Match Scoring Algorithm
 * Calculates confidence match percentage (0% to 99%) between candidate task pair based on:
 *  - Pattern confidence in `dependency_patterns`
 *  - Usage count & match score in `master_dependencies`
 *  - Keyword overlap & semantic concept alignment
 * 
 * @param {Object} newTask - Task being created/checked { id, title, description }
 * @param {Array<Object>} existingTasks - List of existing user tasks in project
 * @param {Array<Object>} userEdges - Current confirmed dependencies
 * @returns {Array<Object>} Sorted list of match suggestions with match_score_pct (highest score first)
 */
function calculateDAGMatchScore(newTask, existingTasks, userEdges = []) {
  const newTaskConcepts = extractMasterKeywords(newTask.title, newTask.description);
  const suggestions = [];

  const masterDeps = memoryStore.master_dependencies || [];
  const patterns = memoryStore.dependency_patterns || [];
  const userEdgeSet = new Set(
    userEdges.map(e => `${e.task_id}->${e.depends_on_task_id}`)
  );

  for (const existingTask of existingTasks) {
    if (String(existingTask.id) === String(newTask.id)) continue;

    const existingConcepts = extractMasterKeywords(existingTask.title, existingTask.description);

    // Scenario A: newTask DEPENDS ON existingTask (existingTask is prerequisite)
    // Concept direction: newTask (source_concept) depends on existingTask (target_concept)
    let maxScoreA = 0;
    let matchedReasonA = '';
    let matchedSourceConcA = '';
    let matchedTargetConcA = '';

    for (const newConc of newTaskConcepts) {
      for (const exConc of existingConcepts) {
        if (newConc === exConc) continue;

        // Check master_dependencies
        const masterMatch = masterDeps.find(
          m => (m.source_concept === newConc && m.target_concept === exConc)
        );

        // Check dependency_patterns
        const patternMatch = patterns.find(
          p => (p.source_concept === newConc && p.target_concept === exConc)
        );

        let score = 0;
        let reason = '';

        if (masterMatch) {
          // Score formula based on usage_count and base match_score
          const usageBonus = Math.min(25, (masterMatch.usage_count || 1) * 5);
          score = Math.round((masterMatch.match_score || 0.8) * 70 + usageBonus);
          reason = `DAG System Pattern Match: '${newConc}' typically depends on '${exConc}' (${masterMatch.usage_count || 1} workspace confirmations).`;
        } else if (patternMatch) {
          score = Math.round((patternMatch.confidence || 0.75) * 85);
          reason = `Historical Pattern Match: '${newConc}' tasks depend on '${exConc}'.`;
        } else {
          // Heuristic fallback for common tech stack relationships
          if ((newConc === 'webhook' || newConc === 'stripe') && (exConc === 'auth' || exConc === 'schema')) {
            score = 82;
            reason = `Domain Dependency Heuristic: '${newTask.title}' requires prerequisite setup of '${existingTask.title}'.`;
          } else if ((newConc === 'ui' || newConc === 'api') && exConc === 'schema') {
            score = 88;
            reason = `Domain Dependency Heuristic: '${newConc}' layer depends on data schema '${exConc}'.`;
          } else if (newConc === 'testing' && (exConc === 'api' || exConc === 'ui')) {
            score = 85;
            reason = `Domain Dependency Heuristic: Testing '${newTask.title}' requires built feature '${existingTask.title}'.`;
          }
        }

        if (score > maxScoreA) {
          maxScoreA = Math.min(98, score);
          matchedReasonA = reason;
          matchedSourceConcA = newConc;
          matchedTargetConcA = exConc;
        }
      }
    }

    if (maxScoreA >= 50) {
      const edgeKey = `${newTask.id}->${existingTask.id}`;
      if (!userEdgeSet.has(edgeKey)) {
        suggestions.push({
          prerequisite_id: existingTask.id,
          dependent_id: newTask.id,
          prereq_title: existingTask.title,
          dep_title: newTask.title,
          match_score_pct: maxScoreA,
          reasoning: matchedReasonA,
          source_concept: matchedSourceConcA,
          target_concept: matchedTargetConcA,
          source: 'dag_system'
        });
      }
    }

    // Scenario B: existingTask DEPENDS ON newTask (newTask is prerequisite for existingTask)
    let maxScoreB = 0;
    let matchedReasonB = '';
    let matchedSourceConcB = '';
    let matchedTargetConcB = '';

    for (const exConc of existingConcepts) {
      for (const newConc of newTaskConcepts) {
        if (exConc === newConc) continue;

        const masterMatch = masterDeps.find(
          m => (m.source_concept === exConc && m.target_concept === newConc)
        );
        const patternMatch = patterns.find(
          p => (p.source_concept === exConc && p.target_concept === newConc)
        );

        let score = 0;
        let reason = '';

        if (masterMatch) {
          const usageBonus = Math.min(25, (masterMatch.usage_count || 1) * 5);
          score = Math.round((masterMatch.match_score || 0.8) * 70 + usageBonus);
          reason = `DAG System Pattern Match: Existing task '${existingTask.title}' depends on '${newTask.title}'.`;
        } else if (patternMatch) {
          score = Math.round((patternMatch.confidence || 0.75) * 85);
          reason = `Historical Pattern Match: '${exConc}' tasks depend on '${newConc}'.`;
        }

        if (score > maxScoreB) {
          maxScoreB = Math.min(98, score);
          matchedReasonB = reason;
          matchedSourceConcB = exConc;
          matchedTargetConcB = newConc;
        }
      }
    }

    if (maxScoreB >= 50) {
      const edgeKey = `${existingTask.id}->${newTask.id}`;
      if (!userEdgeSet.has(edgeKey)) {
        suggestions.push({
          prerequisite_id: newTask.id,
          dependent_id: existingTask.id,
          prereq_title: newTask.title,
          dep_title: existingTask.title,
          match_score_pct: maxScoreB,
          reasoning: matchedReasonB,
          source_concept: matchedSourceConcB,
          target_concept: matchedTargetConcB,
          source: 'dag_system'
        });
      }
    }
  }

  // Sort descending by match_score_pct
  return suggestions.sort((a, b) => b.match_score_pct - a.match_score_pct);
}

/**
 * Extracts keywords from source and target tasks and updates/inserts into pattern DB
 * 
 * @param {string} depTitle 
 * @param {string} prereqTitle 
 * @param {string} [depDesc] 
 * @param {string} [prereqDesc] 
 * @param {number} [userId=1] 
 */
function recordPatternFeedback(depTitle, prereqTitle, depDesc = '', prereqDesc = '', userId = 1) {
  const depConcepts = extractMasterKeywords(depTitle, depDesc);
  const prereqConcepts = extractMasterKeywords(prereqTitle, prereqDesc);

  if (depConcepts.length === 0 || prereqConcepts.length === 0) return;

  const sourceConcept = depConcepts[0];
  const targetConcept = prereqConcepts[0];

  if (sourceConcept === targetConcept) return;

  // 1. Update/Insert in master_dependencies
  if (!memoryStore.master_dependencies) memoryStore.master_dependencies = [];
  let master = memoryStore.master_dependencies.find(
    m => m.source_concept === sourceConcept && m.target_concept === targetConcept
  );

  if (master) {
    master.usage_count = (master.usage_count || 1) + 1;
    master.match_score = Math.min(1.0, (master.match_score || 0.8) + 0.05);
  } else {
    memoryStore.master_dependencies.push({
      id: nextIds.master_dependencies++,
      source_concept: sourceConcept,
      target_concept: targetConcept,
      match_score: 0.85,
      usage_count: 1
    });
  }

  // 2. Update/Insert in dependency_patterns
  if (!memoryStore.dependency_patterns) memoryStore.dependency_patterns = [];
  let pattern = memoryStore.dependency_patterns.find(
    p => p.source_concept === sourceConcept && p.target_concept === targetConcept
  );

  if (pattern) {
    pattern.accepted_count = (pattern.accepted_count || 1) + 1;
    pattern.confidence = Math.min(1.0, (pattern.confidence || 0.8) + 0.05);
  } else {
    memoryStore.dependency_patterns.push({
      id: nextIds.dependency_patterns++,
      user_id: userId,
      source_concept: sourceConcept,
      target_concept: targetConcept,
      confidence: 0.85,
      accepted_count: 1
    });
  }
}

/**
 * Legacy compatibility helper for KB pattern suggestions
 */
function findKBPatternSuggestions(tasks, projectId = 1) {
  const suggestions = [];
  const processedKeys = new Set();

  for (const t of tasks) {
    const matches = calculateDAGMatchScore(t, tasks, []);
    for (const m of matches) {
      const key = `${m.prerequisite_id}->${m.dependent_id}`;
      if (!processedKeys.has(key)) {
        processedKeys.add(key);
        suggestions.push({
          source: 'knowledge_base',
          payload: {
            prerequisite_id: m.prerequisite_id,
            dependent_id: m.dependent_id,
            prereq_title: m.prereq_title,
            dep_title: m.dep_title,
            reasoning: m.reasoning,
            match_score_pct: m.match_score_pct
          }
        });
      }
    }
  }
  return suggestions;
}

module.exports = {
  extractMasterKeywords,
  extractConcepts: extractMasterKeywords,
  calculateDAGMatchScore,
  findKBPatternSuggestions,
  recordPatternFeedback
};
