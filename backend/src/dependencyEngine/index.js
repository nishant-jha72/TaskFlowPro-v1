/**
 * Facade entry point for the Deterministic Dependency Graph Engine.
 */

const { wouldCreateCycle } = require('./cycleDetection');
const { computeReadiness } = require('./readiness');
const { propagateSchedules } = require('./schedulePropagation');
const { handleTaskStatusChange } = require('./rollback');

/**
 * Full graph recalculation pipeline.
 * Given tasks & edges, returns updated tasks with calculated status and schedule dates.
 */
function processGraph(tasks, edges) {
  const { updatedTasks: readinessMap, topoOrder, hasCycle } = computeReadiness(tasks, edges);
  const scheduledTaskMap = propagateSchedules(readinessMap, edges, topoOrder);
  return {
    tasks: Array.from(scheduledTaskMap.values()),
    topoOrder,
    hasCycle
  };
}

module.exports = {
  wouldCreateCycle,
  computeReadiness,
  propagateSchedules,
  handleTaskStatusChange,
  processGraph
};
