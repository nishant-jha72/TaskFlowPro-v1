/**
 * Schedule Propagation Module (4.3)
 * Constraint-based scheduling:
 *   task.start_date = MAX(end_date of ALL prerequisite tasks)
 *   task.end_date   = task.start_date + task.duration
 * 
 * Nodes are processed in topological order so prerequisites' dates are finalized first.
 * Crucially, MAX() prevents double-counting delay at converging ("diamond") dependency paths.
 */

/**
 * Helper to add days to a Date object or ISO string.
 */
function addDays(dateStrOrObj, days) {
  const d = new Date(dateStrOrObj);
  if (isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + Number(days));
  return d.toISOString().split('T')[0];
}

/**
 * Formats a Date object to YYYY-MM-DD.
 */
function formatDate(dateObj) {
  if (!dateObj || isNaN(new Date(dateObj).getTime())) return null;
  return new Date(dateObj).toISOString().split('T')[0];
}

/**
 * Propagates dates through the graph in topological order.
 * 
 * @param {Map<string, Object>|Array<Object>} tasks - Tasks map or list
 * @param {Array<Object>} edges - List of edges [{ task_id, depends_on_task_id }]
 * @param {Array<string>} topoOrder - Array of task IDs in topological order
 * @returns {Map<string, Object>} Map of task ID to updated task with calculated start_date & end_date
 */
function propagateSchedules(tasks, edges, topoOrder) {
  const taskMap = new Map();
  if (tasks instanceof Map) {
    tasks.forEach((v, k) => taskMap.set(String(k), { ...v, id: String(k) }));
  } else if (Array.isArray(tasks)) {
    tasks.forEach(t => taskMap.set(String(t.id), { ...t, id: String(t.id) }));
  }

  // Map task_id => array of prerequisite task_ids
  const prereqMap = new Map();
  edges.forEach(edge => {
    const taskId = String(edge.task_id);
    const prereqId = String(edge.depends_on_task_id);
    if (!prereqMap.has(taskId)) {
      prereqMap.set(taskId, []);
    }
    prereqMap.get(taskId).push(prereqId);
  });

  const order = topoOrder && topoOrder.length === taskMap.size ? topoOrder : Array.from(taskMap.keys());

  for (const taskId of order) {
    const task = taskMap.get(taskId);
    if (!task) continue;

    const prereqIds = prereqMap.get(taskId) || [];
    const duration = Math.max(1, Number(task.duration || 1));

    if (prereqIds.length === 0) {
      // Root task with no prerequisites
      const startDate = task.start_date ? formatDate(task.start_date) : formatDate(new Date());
      const endDate = addDays(startDate, duration);
      taskMap.set(taskId, {
        ...task,
        start_date: startDate,
        end_date: endDate,
        duration
      });
    } else {
      // Find MAX end_date among all direct prerequisites
      let maxPrereqEndDate = null;
      for (const pId of prereqIds) {
        const pTask = taskMap.get(pId);
        if (pTask && pTask.end_date) {
          if (!maxPrereqEndDate || new Date(pTask.end_date) > new Date(maxPrereqEndDate)) {
            maxPrereqEndDate = pTask.end_date;
          }
        }
      }

      let startDate = task.start_date ? formatDate(task.start_date) : formatDate(new Date());
      if (maxPrereqEndDate) {
        // Dependent task start date is the MAX of prerequisite end dates
        startDate = maxPrereqEndDate;
      }

      const endDate = addDays(startDate, duration);
      taskMap.set(taskId, {
        ...task,
        start_date: startDate,
        end_date: endDate,
        duration
      });
    }
  }

  return taskMap;
}

module.exports = {
  propagateSchedules,
  addDays,
  formatDate
};
