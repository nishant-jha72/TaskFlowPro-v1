/**
 * Rollback & Re-evaluation Module (4.4)
 * If a 'done' task regresses to an earlier status (e.g., 'not_started' or 'in_progress'),
 * treat it as a full mutation event: re-evaluate readiness (4.2) and schedule propagation (4.3)
 * across the entire graph. Downstream tasks' readiness and schedules invalidate and recompute.
 */

const { computeReadiness } = require('./readiness');
const { propagateSchedules } = require('./schedulePropagation');

/**
 * Handles status change / rollback event and recomputes whole graph state.
 * 
 * @param {Array<Object>} tasks - List of task objects
 * @param {Array<Object>} edges - List of dependency edge objects
 * @param {string|number} targetTaskId - ID of task being updated
 * @param {string} newStatus - New status for target task ('not_started' | 'ready' | 'blocked' | 'in_progress' | 'done')
 * @returns {Object} { tasks: Array<Object>, topoOrder: Array<string>, hasCycle: boolean }
 */
function handleTaskStatusChange(tasks, edges, targetTaskId, newStatus) {
  const targetIdStr = String(targetTaskId);

  // 1. Update status of the specified task
  const updatedTaskList = tasks.map(t => {
    if (String(t.id) === targetIdStr) {
      return { ...t, status: newStatus };
    }
    return t;
  });

  // 2. Re-compute full-graph readiness (Kahn's BFS top-sort)
  const { updatedTasks: readinessMap, topoOrder, hasCycle } = computeReadiness(updatedTaskList, edges);

  // 3. Propagate schedule changes across the graph using top-sort order
  const scheduledTaskMap = propagateSchedules(readinessMap, edges, topoOrder);

  return {
    tasks: Array.from(scheduledTaskMap.values()),
    topoOrder,
    hasCycle
  };
}

module.exports = {
  handleTaskStatusChange
};
