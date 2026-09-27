const {
  wouldCreateCycle,
  computeReadiness,
  propagateSchedules,
  handleTaskStatusChange,
  processGraph
} = require('../index');

describe('Deterministic Dependency Engine Unit Tests', () => {

  describe('4.1 Cycle Detection (wouldCreateCycle)', () => {
    test('Rejects self-loop (A -> A)', () => {
      const adjList = { 1: [] };
      expect(wouldCreateCycle(1, 1, adjList)).toBe(true);
    });

    test('Rejects 2-node cycle (A -> B when B -> A exists)', () => {
      // B (2) depends on A (1)
      const adjList = {
        1: [],
        2: [1]
      };
      // Propose A (1) depends on B (2) -> would create 1 -> 2 -> 1 cycle
      expect(wouldCreateCycle(1, 2, adjList)).toBe(true);
    });

    test('Rejects multi-node cycle (A -> B -> C -> A)', () => {
      // C (3) depends on B (2); B (2) depends on A (1)
      const adjList = {
        1: [],
        2: [1],
        3: [2]
      };
      // Propose A (1) depends on C (3) -> would create 1 -> 3 -> 2 -> 1
      expect(wouldCreateCycle(1, 3, adjList)).toBe(true);
    });

    test('Allows valid DAG edge (A -> C when B -> C and A -> B exist)', () => {
      // B (2) depends on A (1)
      const adjList = {
        1: [],
        2: [1],
        3: []
      };
      // Propose C (3) depends on B (2) -> valid
      expect(wouldCreateCycle(3, 2, adjList)).toBe(false);
    });
  });

  describe('4.2 Full-Graph Readiness Recomputation (computeReadiness)', () => {
    test('Task with 0 prerequisites is Ready', () => {
      const tasks = [{ id: '1', title: 'Task A', status: 'not_started' }];
      const edges = [];
      const result = computeReadiness(tasks, edges);
      expect(result.updatedTasks.get('1').status).toBe('ready');
    });

    test('Task with incomplete prerequisite is Blocked', () => {
      const tasks = [
        { id: '1', title: 'Task A', status: 'not_started' },
        { id: '2', title: 'Task B', status: 'not_started' } // B depends on A
      ];
      const edges = [{ task_id: '2', depends_on_task_id: '1' }];
      const result = computeReadiness(tasks, edges);

      expect(result.updatedTasks.get('1').status).toBe('ready');
      expect(result.updatedTasks.get('2').status).toBe('blocked');
    });

    test('Task with multiple prerequisites in mixed completion states', () => {
      const tasks = [
        { id: '1', title: 'Task A', status: 'done' },
        { id: '2', title: 'Task B', status: 'not_started' },
        { id: '3', title: 'Task C', status: 'not_started' } // C depends on A and B
      ];
      const edges = [
        { task_id: '3', depends_on_task_id: '1' },
        { task_id: '3', depends_on_task_id: '2' }
      ];
      const result = computeReadiness(tasks, edges);

      expect(result.updatedTasks.get('3').status).toBe('blocked'); // Because B is not done
    });

    test('Task becomes Ready when ALL prerequisites are done', () => {
      const tasks = [
        { id: '1', title: 'Task A', status: 'done' },
        { id: '2', title: 'Task B', status: 'done' },
        { id: '3', title: 'Task C', status: 'not_started' }
      ];
      const edges = [
        { task_id: '3', depends_on_task_id: '1' },
        { task_id: '3', depends_on_task_id: '2' }
      ];
      const result = computeReadiness(tasks, edges);

      expect(result.updatedTasks.get('3').status).toBe('ready');
    });
  });

  describe('4.3 Schedule Propagation & Converging Diamond Dependencies', () => {
    test('Diamond Dependency Test: +3 days upstream on two converging paths -> exactly +3 days downstream (not +6)', () => {
      /**
       * Graph Structure:
       *        Task A (start: 2026-01-01, dur: 2) -> ends 2026-01-03
       *       /      \
       *   Task B      Task C  (both depend on A, dur: 5)
       *       \      /
       *        Task D (depends on B and C, dur: 3)
       *
       * If both Task B and Task C slip by +3 days (e.g. duration increased or end date pushed),
       * Task D start date = MAX(Task B end_date, Task C end_date).
       * Delay must NOT double-count to +6 days!
       */
      const tasks = [
        { id: 'A', title: 'Task A', start_date: '2026-01-01', duration: 2, status: 'done' },
        { id: 'B', title: 'Task B', start_date: '2026-01-03', duration: 5 + 3, status: 'in_progress' }, // +3 days delay = 8 days duration
        { id: 'C', title: 'Task C', start_date: '2026-01-03', duration: 5 + 3, status: 'in_progress' }, // +3 days delay = 8 days duration
        { id: 'D', title: 'Task D', start_date: '2026-01-08', duration: 3, status: 'blocked' }
      ];

      const edges = [
        { task_id: 'B', depends_on_task_id: 'A' },
        { task_id: 'C', depends_on_task_id: 'A' },
        { task_id: 'D', depends_on_task_id: 'B' },
        { task_id: 'D', depends_on_task_id: 'C' }
      ];

      const { updatedTasks, topoOrder } = computeReadiness(tasks, edges);
      const scheduledMap = propagateSchedules(updatedTasks, edges, topoOrder);

      const taskA = scheduledMap.get('A');
      const taskB = scheduledMap.get('B');
      const taskC = scheduledMap.get('C');
      const taskD = scheduledMap.get('D');

      expect(taskA.end_date).toBe('2026-01-03');
      expect(taskB.start_date).toBe('2026-01-03');
      expect(taskB.end_date).toBe('2026-01-11'); // 2026-01-03 + 8 days = Jan 11

      expect(taskC.start_date).toBe('2026-01-03');
      expect(taskC.end_date).toBe('2026-01-11'); // 2026-01-03 + 8 days = Jan 11

      // Downstream Task D must start on MAX(Jan 11, Jan 11) = Jan 11 (+3 days delay total from initial Jan 8 target), NOT Jan 14 (+6)!
      expect(taskD.start_date).toBe('2026-01-11');
      expect(taskD.end_date).toBe('2026-01-14');
    });
  });

  describe('4.4 Rollback (handleTaskStatusChange)', () => {
    test('Rollback of a completed task regresses downstream readiness', () => {
      const tasks = [
        { id: '1', title: 'Task A', status: 'done' },
        { id: '2', title: 'Task B', status: 'ready' } // B depends on A, currently ready because A is done
      ];
      const edges = [{ task_id: '2', depends_on_task_id: '1' }];

      // Revert Task A back to 'not_started' or 'in_progress'
      const { tasks: updatedList } = handleTaskStatusChange(tasks, edges, '1', 'in_progress');

      const taskB = updatedList.find(t => String(t.id) === '2');
      expect(taskB.status).toBe('blocked');
    });
  });

});
