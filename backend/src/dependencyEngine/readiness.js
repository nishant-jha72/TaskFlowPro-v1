/**
 * Full-Graph Readiness Recomputation (4.2)
 * Kahn's algorithm (BFS-based topological sort) to compute task readiness & topological ordering.
 * 
 * Rules:
 * - A task with status 'done' maintains 'done'.
 * - A non-done task is 'ready' iff ALL of its direct prerequisites are 'done' (or if it has 0 prerequisites).
 * - Otherwise, a non-done task is 'blocked'.
 * - Returns { updatedTasks, topoOrder, hasCycle }
 */

/**
 * Recomputes task readiness and produces a topological ordering using Kahn's algorithm.
 * 
 * @param {Array<Object>} tasks - List of task objects [{ id, status, ... }]
 * @param {Array<Object>} edges - List of dependency objects [{ task_id, depends_on_task_id }]
 * @returns {Object} { updatedTasks: Map<id, Object>, topoOrder: Array<id>, hasCycle: boolean }
 */
function computeReadiness(tasks, edges) {
  const taskMap = new Map();
  const inDegree = new Map();
  const directPrereqs = new Map(); // task_id => Set(prereq_ids)
  const downstreamDependents = new Map(); // prereq_id => Set(dependent_ids)

  tasks.forEach(t => {
    const id = String(t.id);
    taskMap.set(id, { ...t, id });
    inDegree.set(id, 0);
    directPrereqs.set(id, new Set());
    downstreamDependents.set(id, new Set());
  });

  // Populate edges & in-degrees
  edges.forEach(edge => {
    const taskId = String(edge.task_id);
    const prereqId = String(edge.depends_on_task_id);

    if (taskMap.has(taskId) && taskMap.has(prereqId)) {
      directPrereqs.get(taskId).add(prereqId);
      downstreamDependents.get(prereqId).add(taskId);
      inDegree.set(taskId, (inDegree.get(taskId) || 0) + 1);
    }
  });

  // Kahn's algorithm setup
  const queue = [];
  inDegree.forEach((deg, id) => {
    if (deg === 0) {
      queue.push(id);
    }
  });

  const topoOrder = [];
  while (queue.length > 0) {
    const currentId = queue.shift();
    topoOrder.push(currentId);

    const dependents = downstreamDependents.get(currentId) || new Set();
    dependents.forEach(depId => {
      const currentDeg = inDegree.get(depId) - 1;
      inDegree.set(depId, currentDeg);
      if (currentDeg === 0) {
        queue.push(depId);
      }
    });
  }

  const hasCycle = topoOrder.length !== taskMap.size;

  // Calculate status for each task based on prerequisites
  const updatedTasks = new Map();
  taskMap.forEach((task, id) => {
    const prereqs = directPrereqs.get(id) || new Set();
    
    // Check if all prerequisites are done
    let allPrereqsDone = true;
    for (const prereqId of prereqs) {
      const prereqTask = taskMap.get(prereqId);
      if (!prereqTask || prereqTask.status !== 'done') {
        allPrereqsDone = false;
        break;
      }
    }

    let computedStatus = task.status;
    if (!allPrereqsDone) {
      // Strictly block any task whose prerequisites are not completed
      computedStatus = 'blocked';
    } else if (task.status === 'blocked' || task.status === 'not_started') {
      computedStatus = 'ready';
    }

    updatedTasks.set(id, {
      ...task,
      status: computedStatus,
      prerequisitesCount: prereqs.size,
      allPrereqsDone
    });
  });

  return {
    updatedTasks,
    topoOrder: hasCycle ? Array.from(taskMap.keys()) : topoOrder,
    hasCycle
  };
}

module.exports = {
  computeReadiness
};
