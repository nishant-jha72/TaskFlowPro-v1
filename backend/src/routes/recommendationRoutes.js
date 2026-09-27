/**
 * API Endpoints for Task Dependency Recommendation System
 */

const express = require('express');
const router = express.Router();
const pgClient = require('../db/pgClient');
const { memoryStore } = require('../db/index');

const { resolveTaskName, confirmAlias } = require('../dependencyEngine/resolutionPipeline');
const { getSuggestedDependencies, confirmDependencies } = require('../dependencyEngine/dependencySuggestion');

// Helper to select active DB context (pgClient if connected, otherwise memoryStore)
function getDbContext() {
  if (pgClient.isPgConnected) {
    return pgClient;
  }
  return memoryStore;
}

/**
 * POST /tasks/resolve
 * Resolves an array of task_names through Layers 1-3.
 * Returns canonical_task_ids, confidence scores, and any items needing user confirmation.
 */
router.post('/resolve', async (req, res) => {
  try {
    const { task_names } = req.body;
    if (!Array.isArray(task_names) || task_names.length === 0) {
      return res.status(400).json({ error: 'task_names must be a non-empty array of strings' });
    }

    const dbContext = getDbContext();
    const resolvedTasks = [];
    const pendingConfirmations = [];

    for (const name of task_names) {
      if (typeof name !== 'string' || !name.trim()) continue;
      const result = await resolveTaskName(name.trim(), dbContext);
      
      resolvedTasks.push({
        input_text: name,
        canonical_task_id: result.canonical_task_id,
        canonical_name: result.canonical_name,
        layer: result.layer,
        confidence_score: result.confidence_score,
        pending_confirmation: result.pending_confirmation,
        is_new_task: !!result.is_new_task,
        reasoning: result.reasoning
      });

      if (result.pending_confirmation) {
        pendingConfirmations.push({
          alias_text: name,
          canonical_task_id: result.canonical_task_id,
          suggested_canonical_name: result.canonical_name,
          reasoning: result.reasoning
        });
      }
    }

    return res.json({
      success: true,
      resolved_tasks: resolvedTasks,
      pending_confirmations: pendingConfirmations
    });
  } catch (err) {
    console.error('[POST /tasks/resolve] Error:', err);
    return res.status(500).json({ error: 'Failed to resolve task names', details: err.message });
  }
});

/**
 * POST /tasks/confirm-alias
 * Commits a user-confirmed alias mapping and increases trust weight.
 */
router.post('/confirm-alias', async (req, res) => {
  try {
    const { alias_text, canonical_task_id } = req.body;
    if (!alias_text || !canonical_task_id) {
      return res.status(400).json({ error: 'alias_text and canonical_task_id are required' });
    }

    const dbContext = getDbContext();
    const result = await confirmAlias(alias_text, canonical_task_id, dbContext);

    return res.json(result);
  } catch (err) {
    console.error('[POST /tasks/confirm-alias] Error:', err);
    return res.status(500).json({ error: 'Failed to confirm task alias', details: err.message });
  }
});

/**
 * GET /tasks/:id/suggested-dependencies
 * Returns ranked dependency suggestions for task ID from dependency_patterns.
 * Supports query parameter ?canonical_ids=id1,id2 for batch DAG context.
 */
router.get('/:id/suggested-dependencies', async (req, res) => {
  try {
    const taskId = req.params.id;
    const dbContext = getDbContext();

    let targetIds = [taskId];
    if (req.query.canonical_ids) {
      const extraIds = req.query.canonical_ids.split(',').map((s) => s.trim()).filter(Boolean);
      targetIds = Array.from(new Set([taskId, ...extraIds]));
    }

    const suggestions = await getSuggestedDependencies(targetIds, dbContext);
    const taskSuggestions = suggestions.filter((s) => s.task_id === taskId || targetIds.includes(s.task_id));

    return res.json({
      success: true,
      task_id: taskId,
      suggestions: taskSuggestions
    });
  } catch (err) {
    console.error('[GET /tasks/:id/suggested-dependencies] Error:', err);
    return res.status(500).json({ error: 'Failed to fetch suggested dependencies', details: err.message });
  }
});

/**
 * POST /tasks/confirm-dependencies
 * Commits confirmed DAG edges and updates precomputed pattern frequencies.
 */
router.post('/confirm-dependencies', async (req, res) => {
  try {
    const { edges, user_id } = req.body;
    if (!Array.isArray(edges)) {
      return res.status(400).json({ error: 'edges must be an array of objects containing task_id and depends_on_task_id' });
    }

    const dbContext = getDbContext();
    const result = await confirmDependencies(user_id || 1, edges, dbContext);

    return res.json(result);
  } catch (err) {
    console.error('[POST /tasks/confirm-dependencies] Error:', err);
    return res.status(500).json({ error: 'Failed to confirm task dependencies', details: err.message });
  }
});

module.exports = router;
