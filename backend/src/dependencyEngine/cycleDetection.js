/**
 * Cycle Detection Module (4.1)
 * Targeted DFS reachability check from target node B to source node A before inserting edge A -> B (A depends on B).
 * Returns true if adding edge (taskId -> dependsOnTaskId) creates a cycle, false otherwise.
 */

/**
 * Checks if targetTaskId can reach sourceTaskId in the graph.
 * If targetTaskId can reach sourceTaskId, then adding (sourceTaskId -> targetTaskId) creates a cycle.
 * 
 * @param {number|string} sourceTaskId - The dependent task (A)
 * @param {number|string} targetTaskId - The prerequisite task (B)
 * @param {Map<number|string, Array<number|string>>|Object} adjacencyList - Map of task_id => array of depends_on_task_ids
 * @returns {boolean} true if cycle detected, false if valid
 */
function wouldCreateCycle(sourceTaskId, targetTaskId, adjacencyList) {
  // Convert IDs to consistent type (string or number)
  const sourceStr = String(sourceTaskId);
  const targetStr = String(targetTaskId);

  // 1. Trivial self-dependency check (A -> A)
  if (sourceStr === targetStr) {
    return true;
  }

  // Ensure normalized adj map (key: task_id, value: array of prerequisite task_ids)
  const graph = new Map();
  if (adjacencyList instanceof Map) {
    for (const [k, v] of adjacencyList.entries()) {
      graph.set(String(k), (v || []).map(String));
    }
  } else if (typeof adjacencyList === 'object' && adjacencyList !== null) {
    for (const k of Object.keys(adjacencyList)) {
      graph.set(String(k), (adjacencyList[k] || []).map(String));
    }
  }

  // 2. DFS Reachability check: Can targetStr reach sourceStr through existing prerequisite links?
  // Note: An edge (X -> Y) means X depends on Y.
  // If targetStr depends on ... which eventually depends on sourceStr, then targetStr can reach sourceStr.
  const visited = new Set();
  const stack = [targetStr];

  while (stack.length > 0) {
    const current = stack.pop();

    if (current === sourceStr) {
      return true; // Reached source! Adding source -> target creates source -> target -> ... -> source cycle.
    }

    if (!visited.has(current)) {
      visited.add(current);
      const prereqs = graph.get(current) || [];
      for (const prereq of prereqs) {
        if (!visited.has(prereq)) {
          stack.push(prereq);
        }
      }
    }
  }

  return false;
}

module.exports = {
  wouldCreateCycle
};
