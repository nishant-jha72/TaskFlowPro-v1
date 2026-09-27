/**
 * Express REST API Server
 * Express controllers wrapping atomic dependency transactions, task CRUD,
 * cycle validation, AI suggestions, persistent DB storage, and live metrics.
 *
 * NEW in this version:
 *  - POST /api/tasks   → stores PENDING suggestion in user_dependency_relations (not auto-confirmed)
 *  - GET  /api/dependency-suggestions  → returns pending suggestions for current user
 *  - POST /api/dependency-suggestions/:id/confirm → confirms suggestion, writes edge to user_dependencies
 *  - POST /api/dependency-suggestions/:id/reject  → marks suggestion rejected
 *  - PATCH /api/tasks/:id/position → saves drag-position to user_task_preferences
 *  - GET  /api/graph  → edges from confirmed user_dependencies only
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { memoryStore, nextIds, saveToDisk } = require('./db');
const { initPgDatabase, isPgConnected } = require('./db/pgClient');
const engine = require('./dependencyEngine');
const patternMatcher = require('./services/patternMatcher');
const llmService = require('./services/llmService');
const recommendationRoutes = require('./routes/recommendationRoutes');

const JWT_SECRET = process.env.JWT_SECRET || 'taskflow_secret_key_2026';

const app = express();
app.use(cors());
app.use(express.json());

// Mount Task Dependency Recommendation System routes (/tasks/resolve, /tasks/confirm-alias, etc.)
app.use('/tasks', recommendationRoutes);
app.use('/api/tasks/recommendations', recommendationRoutes);

// Initialize PostgreSQL database connection & migration on startup
initPgDatabase();

// Real System Performance Efficiency Counters
let metrics = {
  kb_hits: 0,
  llm_calls: 0,
  total_tasks_created: 0
};

// Middleware: Authentication with user ownership enforcement
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    req.user = { id: 1, name: 'Demo Lead', email: 'lead@taskflow.pro' };
    return next();
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      req.user = { id: 1, name: 'Demo Lead', email: 'lead@taskflow.pro' };
    } else {
      req.user = user;
    }
    next();
  });
}

// Helper: Ensure user has a project record
function getUserProject(userId) {
  let project = memoryStore.projects.find(p => p.user_id === userId);
  if (!project) {
    project = {
      id: nextIds.projects++,
      user_id: userId,
      title: `${userId}'s Workspace`,
      description: 'Personal Engineering Board'
    };
    memoryStore.projects.push(project);
    saveToDisk();
  }
  return project;
}

// Helper: get confirmed edges for a user (from user_dependencies table)
function getUserConfirmedEdges(userId) {
  return (memoryStore.user_dependencies || []).filter(
    d => d.user_id === userId && d.confirmed === true
  );
}

// Helper: check if edge already exists in user_dependencies
function userEdgeExists(userId, taskId, dependsOnTaskId) {
  return (memoryStore.user_dependencies || []).some(
    d => d.user_id === userId &&
         String(d.task_id) === String(taskId) &&
         String(d.depends_on_task_id) === String(dependsOnTaskId)
  );
}

// -------------------------------------------------------------
// AUTH ROUTES
// -------------------------------------------------------------

app.post('/api/auth/register', (req, res) => {
  const { name, email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  const existing = memoryStore.users.find(u => u.email === email);
  if (existing) {
    return res.status(400).json({ error: 'User already exists' });
  }

  const newUser = {
    id: nextIds.users++,
    name: name || email.split('@')[0],
    email,
    password_hash: bcrypt.hashSync(password, 10)
  };

  memoryStore.users.push(newUser);
  getUserProject(newUser.id); // Create user project container
  saveToDisk();

  const token = jwt.sign({ id: newUser.id, name: newUser.name, email: newUser.email }, JWT_SECRET);
  res.json({ token, user: { id: newUser.id, name: newUser.name, email: newUser.email } });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = memoryStore.users.find(u => u.email === email);

  if (!user || (user.password_hash && !bcrypt.compareSync(password, user.password_hash))) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const token = jwt.sign({ id: user.id, name: user.name, email: user.email }, JWT_SECRET);
  res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
});

app.get('/api/auth/me', authenticateToken, (req, res) => {
  res.json({ user: req.user });
});

// -------------------------------------------------------------
// CORE TASK ROUTES (USER-ISOLATED)
// -------------------------------------------------------------

// GET /api/tasks - List ONLY logged-in user's tasks
app.get('/api/tasks', authenticateToken, (req, res) => {
  const userProject = getUserProject(req.user.id);
  const userTasks = memoryStore.tasks.filter(t => t.project_id === userProject.id);
  const confirmedEdges = getUserConfirmedEdges(req.user.id);

  const { tasks: computedTasks } = engine.processGraph(userTasks, confirmedEdges);
  res.json(computedTasks);
});

// POST /api/tasks - Create task, check manual prerequisite cycles, run DAG Database Matcher
app.post('/api/tasks', authenticateToken, async (req, res) => {
  const { title, description, duration, prerequisite_id } = req.body;
  const userProject = getUserProject(req.user.id);

  if (!title) {
    return res.status(400).json({ error: 'Task title is required' });
  }

  const userTasks = memoryStore.tasks.filter(t => t.project_id === userProject.id);
  const confirmedEdges = getUserConfirmedEdges(req.user.id);

  // If manual prerequisite selected, check for cycle
  if (prerequisite_id) {
    const autoPrereqId = Number(prerequisite_id);
    const tempTaskId = 999999;
    const adjacencyMap = new Map();
    confirmedEdges.forEach(d => {
      if (!adjacencyMap.has(d.task_id)) adjacencyMap.set(d.task_id, []);
      adjacencyMap.get(d.task_id).push(d.depends_on_task_id);
    });

    const createsCycle = engine.wouldCreateCycle(tempTaskId, autoPrereqId, adjacencyMap);
    if (createsCycle) {
      return res.status(400).json({ error: 'Cycle detected: Selected prerequisite creates a circular dependency.' });
    }
  }

  const newTask = {
    id: nextIds.tasks++,
    project_id: userProject.id,
    title,
    description: description || '',
    status: 'not_started',
    start_date: new Date().toISOString().split('T')[0],
    duration: Math.max(1, Number(duration || 1)),
    position: userTasks.length
  };

  memoryStore.tasks.push(newTask);
  metrics.total_tasks_created += 1;

  // Handle manual prerequisite if provided
  if (prerequisite_id) {
    const prereqId = Number(prerequisite_id);
    if (!userEdgeExists(req.user.id, newTask.id, prereqId)) {
      memoryStore.user_dependencies.push({
        id: nextIds.user_dependencies++,
        user_id: req.user.id,
        task_id: newTask.id,
        depends_on_task_id: prereqId,
        confirmed: true,
        created_at: new Date().toISOString()
      });

      const prereqTask = memoryStore.tasks.find(t => t.id === prereqId);
      patternMatcher.recordPatternFeedback(
        newTask.title, prereqTask?.title || '', newTask.description, prereqTask?.description || '', req.user.id
      );
    }
  }

  // ── DAG SYSTEM DATABASE MATCHING (Calculates confidence match scores %) ──
  const updatedUserTasks = memoryStore.tasks.filter(t => t.project_id === userProject.id);
  const currentConfirmedEdges = getUserConfirmedEdges(req.user.id);

  const dbMatches = patternMatcher.calculateDAGMatchScore(newTask, updatedUserTasks, currentConfirmedEdges);

  saveToDisk();

  // Recalculate graph for user's tasks
  const { tasks: computedTasks } = engine.processGraph(updatedUserTasks, currentConfirmedEdges);

  computedTasks.forEach(ut => {
    const match = memoryStore.tasks.find(m => String(m.id) === String(ut.id));
    if (match) {
      match.status = ut.status;
      match.start_date = ut.start_date;
      match.end_date = ut.end_date;
    }
  });

  saveToDisk();

  const createdTask = computedTasks.find(t => String(t.id) === String(newTask.id)) || newTask;
  res.status(201).json({ ...createdTask, dbMatches });
});

// POST /api/dag/match — Standalone endpoint for running DAG Database Pattern Matcher
app.post('/api/dag/match', authenticateToken, (req, res) => {
  const { taskId } = req.body;
  const userProject = getUserProject(req.user.id);
  const userTasks = memoryStore.tasks.filter(t => t.project_id === userProject.id);
  const confirmedEdges = getUserConfirmedEdges(req.user.id);

  const targetTask = memoryStore.tasks.find(t => t.id === Number(taskId));
  if (!targetTask) return res.status(404).json({ error: 'Task not found' });

  const matches = patternMatcher.calculateDAGMatchScore(targetTask, userTasks, confirmedEdges);
  res.json({ matches });
});

// POST /api/llm/suggest — Call Gemini API on demand for 2 grounded dependency suggestions
app.post('/api/llm/suggest', authenticateToken, async (req, res) => {
  const userProject = getUserProject(req.user.id);
  const userTasks = memoryStore.tasks.filter(t => t.project_id === userProject.id);
  const confirmedEdges = getUserConfirmedEdges(req.user.id);

  metrics.llm_calls += 1;
  saveToDisk();

  const suggestions = await llmService.generateLLMSuggestions(userTasks, confirmedEdges);
  res.json({ suggestions });
});

// POST /api/dag/save-keywords — Save/Extract keywords into master & pattern tables
app.post('/api/dag/save-keywords', authenticateToken, (req, res) => {
  const { dep_title, prereq_title, dep_desc, prereq_desc } = req.body;
  patternMatcher.recordPatternFeedback(
    dep_title, prereq_title, dep_desc || '', prereq_desc || '', req.user.id
  );
  saveToDisk();
  res.json({ success: true });
});

// POST /api/dependencies/edit-and-accept — Accept edited/customized dependency
app.post('/api/dependencies/edit-and-accept', authenticateToken, (req, res) => {
  const { task_id, depends_on_task_id } = req.body;
  const taskId = Number(task_id);
  const prereqId = Number(depends_on_task_id);

  if (taskId === prereqId) {
    return res.status(400).json({ error: 'A task cannot depend on itself.' });
  }

  const userProject = getUserProject(req.user.id);
  const userTasks = memoryStore.tasks.filter(t => t.project_id === userProject.id);
  const confirmedEdges = getUserConfirmedEdges(req.user.id);

  const task = userTasks.find(t => t.id === taskId);
  const prereqTask = userTasks.find(t => t.id === prereqId);

  if (!task || !prereqTask) {
    return res.status(404).json({ error: 'Task or prerequisite not found in project.' });
  }

  // Cycle check
  const adjacencyMap = new Map();
  confirmedEdges.forEach(d => {
    if (!adjacencyMap.has(d.task_id)) adjacencyMap.set(d.task_id, []);
    adjacencyMap.get(d.task_id).push(d.depends_on_task_id);
  });

  const createsCycle = engine.wouldCreateCycle(taskId, prereqId, adjacencyMap);
  if (createsCycle) {
    return res.status(400).json({ error: 'Cycle detected: This dependency creates a circular loop.' });
  }

  if (!userEdgeExists(req.user.id, taskId, prereqId)) {
    memoryStore.user_dependencies.push({
      id: nextIds.user_dependencies++,
      user_id: req.user.id,
      task_id: taskId,
      depends_on_task_id: prereqId,
      confirmed: true,
      created_at: new Date().toISOString()
    });
  }

  // Store extracted keywords for future local matches
  patternMatcher.recordPatternFeedback(
    task.title, prereqTask.title, task.description, prereqTask.description, req.user.id
  );

  saveToDisk();
  res.json({ success: true, message: 'Dependency confirmed and keywords extracted to DAG database.' });
});

// PATCH /api/tasks/:id - Update task status & dates
app.patch('/api/tasks/:id', authenticateToken, (req, res) => {
  const taskId = Number(req.params.id);
  const userProject = getUserProject(req.user.id);
  const task = memoryStore.tasks.find(t => t.id === taskId && t.project_id === userProject.id);

  if (!task) {
    return res.status(404).json({ error: 'Task not found or access denied' });
  }

  const { status, title, description, start_date, duration, position } = req.body;

  if (title !== undefined) task.title = title;
  if (description !== undefined) task.description = description;
  if (start_date !== undefined) task.start_date = start_date;
  if (duration !== undefined) task.duration = Math.max(1, Number(duration));
  if (position !== undefined) task.position = position;

  let computedTasks;
  const userTasks = memoryStore.tasks.filter(t => t.project_id === userProject.id);
  const confirmedEdges = getUserConfirmedEdges(req.user.id);

  if (status !== undefined && status !== task.status) {
    if (status !== 'blocked') {
      const prereqEdges = confirmedEdges.filter(e => Number(e.task_id) === taskId);
      for (const edge of prereqEdges) {
        const prereqTask = userTasks.find(t => Number(t.id) === Number(edge.depends_on_task_id));
        if (prereqTask && prereqTask.status !== 'done') {
          return res.status(400).json({
            error: `Cannot update status: Prerequisite '${prereqTask.title}' (#${prereqTask.id}) is not completed yet.`
          });
        }
      }
    }
    task.status = status;
    const result = engine.handleTaskStatusChange(userTasks, confirmedEdges, taskId, status);
    
    result.tasks.forEach(ut => {
      const match = memoryStore.tasks.find(m => String(m.id) === String(ut.id));
      if (match) {
        match.status = ut.status;
        match.start_date = ut.start_date;
        match.end_date = ut.end_date;
      }
    });
    computedTasks = result.tasks;
  } else {
    const result = engine.processGraph(userTasks, confirmedEdges);
    computedTasks = result.tasks;
  }

  saveToDisk();

  res.json(computedTasks.find(t => String(t.id) === String(taskId)) || task);
});

// PATCH /api/tasks/:id/position — save drag-reorder position to user_task_preferences
app.patch('/api/tasks/:id/position', authenticateToken, (req, res) => {
  const taskId = Number(req.params.id);
  const { col_position } = req.body;
  const userId = req.user.id;
  const userProject = getUserProject(userId);

  const task = memoryStore.tasks.find(t => t.id === taskId && t.project_id === userProject.id);
  if (!task) {
    return res.status(404).json({ error: 'Task not found or access denied' });
  }

  if (!memoryStore.user_task_preferences) memoryStore.user_task_preferences = [];
  const existing = memoryStore.user_task_preferences.find(
    p => p.user_id === userId && p.task_id === taskId
  );

  if (existing) {
    existing.col_position = Number(col_position);
    existing.updated_at = new Date().toISOString();
  } else {
    memoryStore.user_task_preferences.push({
      user_id: userId,
      task_id: taskId,
      col_position: Number(col_position),
      updated_at: new Date().toISOString()
    });
  }

  saveToDisk();
  res.json({ success: true, user_id: userId, task_id: taskId, col_position });
});

// DELETE /api/tasks/:id - Delete task
app.delete('/api/tasks/:id', authenticateToken, (req, res) => {
  const taskId = Number(req.params.id);
  const userProject = getUserProject(req.user.id);
  const taskIndex = memoryStore.tasks.findIndex(t => t.id === taskId && t.project_id === userProject.id);

  if (taskIndex === -1) {
    return res.status(404).json({ error: 'Task not found or access denied' });
  }

  memoryStore.tasks.splice(taskIndex, 1);

  // Clean up confirmed edges
  if (memoryStore.user_dependencies) {
    memoryStore.user_dependencies = memoryStore.user_dependencies.filter(
      d => d.task_id !== taskId && d.depends_on_task_id !== taskId
    );
  }
  // Clean up pending relations
  if (memoryStore.user_dependency_relations) {
    memoryStore.user_dependency_relations = memoryStore.user_dependency_relations.filter(
      d => d.task_id !== taskId && d.dep_task_id !== taskId
    );
  }
  // Legacy cleanup
  memoryStore.task_dependencies = memoryStore.task_dependencies.filter(
    d => d.task_id !== taskId && d.depends_on_task_id !== taskId
  );

  saveToDisk();

  const userTasks = memoryStore.tasks.filter(t => t.project_id === userProject.id);
  const confirmedEdges = getUserConfirmedEdges(req.user.id);
  const { tasks: computedTasks } = engine.processGraph(userTasks, confirmedEdges);

  res.json({ success: true, remainingTasksCount: computedTasks.length });
});

// -------------------------------------------------------------
// DEPENDENCY SUGGESTIONS ROUTES (PENDING CONFIRMATION FLOW)
// -------------------------------------------------------------

// GET /api/dependency-suggestions — return user's pending suggestions
app.get('/api/dependency-suggestions', authenticateToken, (req, res) => {
  const userId = req.user.id;
  const pending = (memoryStore.user_dependency_relations || []).filter(
    r => r.user_id === userId && r.accepted === null
  );
  res.json(pending);
});

// POST /api/dependency-suggestions/:id/confirm — user confirms → insert into user_dependencies
app.post('/api/dependency-suggestions/:id/confirm', authenticateToken, (req, res) => {
  const relationId = Number(req.params.id);
  const userId = req.user.id;

  const relation = (memoryStore.user_dependency_relations || []).find(
    r => r.id === relationId && r.user_id === userId
  );

  if (!relation) {
    return res.status(404).json({ error: 'Suggestion not found or access denied' });
  }

  if (relation.accepted !== null) {
    return res.status(400).json({ error: 'Suggestion already processed' });
  }

  // Validate no cycle before confirming
  const confirmedEdges = getUserConfirmedEdges(userId);
  const adjacencyMap = new Map();
  confirmedEdges.forEach(d => {
    if (!adjacencyMap.has(d.task_id)) adjacencyMap.set(d.task_id, []);
    adjacencyMap.get(d.task_id).push(d.depends_on_task_id);
  });

  const createsCycle = engine.wouldCreateCycle(relation.task_id, relation.dep_task_id, adjacencyMap);
  if (createsCycle) {
    relation.accepted = false;
    saveToDisk();
    return res.status(400).json({
      error: `Circular Dependency Rejected! Confirming this would create a cycle.`,
      code: 'CYCLE_DETECTED'
    });
  }

  // Insert into user_dependencies (confirmed=true)
  if (!userEdgeExists(userId, relation.task_id, relation.dep_task_id)) {
    if (!memoryStore.user_dependencies) memoryStore.user_dependencies = [];
    memoryStore.user_dependencies.push({
      id: nextIds.user_dependencies++,
      user_id: userId,
      task_id: relation.task_id,
      depends_on_task_id: relation.dep_task_id,
      confirmed: true,
      created_at: new Date().toISOString()
    });

    // Also record in legacy table for backward compat
    const legacyExists = memoryStore.task_dependencies.find(
      d => String(d.task_id) === String(relation.task_id) &&
           String(d.depends_on_task_id) === String(relation.dep_task_id)
    );
    if (!legacyExists) {
      memoryStore.task_dependencies.push({
        task_id: relation.task_id,
        depends_on_task_id: relation.dep_task_id
      });
    }
  }

  // Update master_dependency usage_count
  if (relation.master_dependency_id) {
    const master = (memoryStore.master_dependencies || []).find(m => m.id === relation.master_dependency_id);
    if (master) master.usage_count = (master.usage_count || 0) + 1;
  }

  // Record pattern feedback
  patternMatcher.recordPatternFeedback(relation.task_title || '', relation.dep_task_title || '', userId);

  relation.accepted = true;
  saveToDisk();

  // Recompute graph
  const userProject = getUserProject(userId);
  const userTasks = memoryStore.tasks.filter(t => t.project_id === userProject.id);
  const newEdges = getUserConfirmedEdges(userId);
  const { tasks: computedTasks } = engine.processGraph(userTasks, newEdges);

  computedTasks.forEach(ut => {
    const match = memoryStore.tasks.find(m => String(m.id) === String(ut.id));
    if (match) {
      match.status = ut.status;
      match.start_date = ut.start_date;
      match.end_date = ut.end_date;
    }
  });
  saveToDisk();

  res.json({ success: true, relation, tasks: computedTasks });
});

// POST /api/dependency-suggestions/:id/reject — marks rejected
app.post('/api/dependency-suggestions/:id/reject', authenticateToken, (req, res) => {
  const relationId = Number(req.params.id);
  const userId = req.user.id;

  const relation = (memoryStore.user_dependency_relations || []).find(
    r => r.id === relationId && r.user_id === userId
  );

  if (!relation) {
    return res.status(404).json({ error: 'Suggestion not found or access denied' });
  }

  relation.accepted = false;
  saveToDisk();

  res.json({ success: true, relation });
});

// -------------------------------------------------------------
// DEPENDENCY ENDPOINTS (WITH DETAILED CYCLE ERROR MESSAGES)
// -------------------------------------------------------------

app.post('/api/dependencies', authenticateToken, (req, res) => {
  const { task_id, depends_on_task_id } = req.body;
  const taskId = Number(task_id);
  const dependsOnTaskId = Number(depends_on_task_id);

  if (!taskId || !dependsOnTaskId) {
    return res.status(400).json({ error: 'Both task_id and depends_on_task_id are required' });
  }

  const userProject = getUserProject(req.user.id);
  const userTasks = memoryStore.tasks.filter(t => t.project_id === userProject.id);
  const depTask = userTasks.find(t => t.id === taskId);
  const prereqTask = userTasks.find(t => t.id === dependsOnTaskId);

  if (!depTask || !prereqTask) {
    return res.status(404).json({ error: 'One or both tasks do not belong to your account.' });
  }

  const confirmedEdges = getUserConfirmedEdges(req.user.id);
  const adjacencyMap = new Map();
  confirmedEdges.forEach(d => {
    if (!adjacencyMap.has(d.task_id)) adjacencyMap.set(d.task_id, []);
    adjacencyMap.get(d.task_id).push(d.depends_on_task_id);
  });

  const createsCycle = engine.wouldCreateCycle(taskId, dependsOnTaskId, adjacencyMap);
  if (createsCycle) {
    return res.status(400).json({
      error: `Circular Dependency Rejected! "${depTask.title}" (#${taskId}) depending on "${prereqTask.title}" (#${dependsOnTaskId}) forms a loop.`,
      code: 'CYCLE_DETECTED',
      details: `Circular loop detected between Task #${taskId} and Task #${dependsOnTaskId}.`
    });
  }

  if (userEdgeExists(req.user.id, taskId, dependsOnTaskId)) {
    return res.status(400).json({ error: 'Dependency edge already exists.' });
  }

  // Insert into user_dependencies (confirmed)
  if (!memoryStore.user_dependencies) memoryStore.user_dependencies = [];
  memoryStore.user_dependencies.push({
    id: nextIds.user_dependencies++,
    user_id: req.user.id,
    task_id: taskId,
    depends_on_task_id: dependsOnTaskId,
    confirmed: true,
    created_at: new Date().toISOString()
  });

  // Legacy table
  memoryStore.task_dependencies.push({ task_id: taskId, depends_on_task_id: dependsOnTaskId });
  patternMatcher.recordPatternFeedback(depTask.title, prereqTask.title, req.user.id);

  const newEdges = getUserConfirmedEdges(req.user.id);
  const { tasks: computedTasks } = engine.processGraph(userTasks, newEdges);
  computedTasks.forEach(ut => {
    const match = memoryStore.tasks.find(m => String(m.id) === String(ut.id));
    if (match) {
      match.status = ut.status;
      match.start_date = ut.start_date;
      match.end_date = ut.end_date;
    }
  });

  saveToDisk();

  res.status(201).json({
    success: true,
    edge: { task_id: taskId, depends_on_task_id: dependsOnTaskId },
    tasks: computedTasks
  });
});

app.delete('/api/dependencies', authenticateToken, (req, res) => {
  const { task_id, depends_on_task_id } = req.body;
  const taskId = Number(task_id);
  const dependsOnTaskId = Number(depends_on_task_id);
  const userId = req.user.id;

  if (memoryStore.user_dependencies) {
    memoryStore.user_dependencies = memoryStore.user_dependencies.filter(
      d => !(d.user_id === userId && d.task_id === taskId && d.depends_on_task_id === dependsOnTaskId)
    );
  }
  memoryStore.task_dependencies = memoryStore.task_dependencies.filter(
    d => !(d.task_id === taskId && d.depends_on_task_id === dependsOnTaskId)
  );

  const userProject = getUserProject(userId);
  const userTasks = memoryStore.tasks.filter(t => t.project_id === userProject.id);
  const confirmedEdges = getUserConfirmedEdges(userId);
  const { tasks: computedTasks } = engine.processGraph(userTasks, confirmedEdges);

  computedTasks.forEach(ut => {
    const match = memoryStore.tasks.find(m => String(m.id) === String(ut.id));
    if (match) {
      match.status = ut.status;
      match.start_date = ut.start_date;
      match.end_date = ut.end_date;
    }
  });

  saveToDisk();

  res.json({ success: true, tasks: computedTasks });
});

// GET /api/graph - Fetch nodes + edges from CONFIRMED user_dependencies only
app.get('/api/graph', authenticateToken, (req, res) => {
  const userProject = getUserProject(req.user.id);
  const userTasks = memoryStore.tasks.filter(t => t.project_id === userProject.id);
  const userTaskIds = new Set(userTasks.map(t => t.id));

  // Use only confirmed user_dependencies that belong to this user's tasks
  const confirmedEdges = getUserConfirmedEdges(req.user.id).filter(
    d => userTaskIds.has(d.task_id) && userTaskIds.has(d.depends_on_task_id)
  );

  const { tasks: computedTasks } = engine.processGraph(userTasks, confirmedEdges);

  res.json({
    nodes: computedTasks,
    edges: confirmedEdges
  });
});

// -------------------------------------------------------------
// AI SUGGESTIONS & METRICS ROUTES
// -------------------------------------------------------------

app.get('/api/suggestions', authenticateToken, async (req, res) => {
  const userProject = getUserProject(req.user.id);
  const userTasks = memoryStore.tasks.filter(t => t.project_id === userProject.id);
  const userTaskIds = new Set(userTasks.map(t => t.id));
  const confirmedEdges = getUserConfirmedEdges(req.user.id).filter(
    d => userTaskIds.has(d.task_id) && userTaskIds.has(d.depends_on_task_id)
  );

  const kbSuggestions = patternMatcher.findKBPatternSuggestions(userTasks, userProject.id);
  let allSuggestions = [];

  if (kbSuggestions.length > 0) {
    metrics.kb_hits += kbSuggestions.length;
    allSuggestions = kbSuggestions;
  } else {
    const llmSuggestions = await llmService.generateLLMSuggestions(userTasks, confirmedEdges);
    metrics.llm_calls += llmSuggestions.length;
    allSuggestions = llmSuggestions;
  }

  allSuggestions.forEach(s => {
    const exists = memoryStore.ai_suggestions.find(
      existing => existing.payload.prerequisite_id === s.payload.prerequisite_id &&
                  existing.payload.dependent_id === s.payload.dependent_id
    );

    if (!exists) {
      memoryStore.ai_suggestions.push({
        id: nextIds.ai_suggestions++,
        project_id: userProject.id,
        source: s.source,
        payload: s.payload,
        accepted: null
      });
    }
  });

  saveToDisk();

  res.json(memoryStore.ai_suggestions.filter(s => s.project_id === userProject.id && s.accepted === null));
});

app.post('/api/suggestions/:id/accept', authenticateToken, (req, res) => {
  const suggestionId = Number(req.params.id);
  const suggestion = memoryStore.ai_suggestions.find(s => s.id === suggestionId);

  if (!suggestion) {
    return res.status(404).json({ error: 'Suggestion not found' });
  }

  const { prerequisite_id, dependent_id, prereq_title, dep_title } = suggestion.payload;
  const userId = req.user.id;

  const confirmedEdges = getUserConfirmedEdges(userId);
  const adjacencyMap = new Map();
  confirmedEdges.forEach(d => {
    if (!adjacencyMap.has(d.task_id)) adjacencyMap.set(d.task_id, []);
    adjacencyMap.get(d.task_id).push(d.depends_on_task_id);
  });

  const createsCycle = engine.wouldCreateCycle(dependent_id, prerequisite_id, adjacencyMap);
  if (createsCycle) {
    suggestion.accepted = false;
    saveToDisk();
    return res.status(400).json({ error: 'Cannot accept suggestion: creates a circular dependency loop.' });
  }

  if (!userEdgeExists(userId, dependent_id, prerequisite_id)) {
    if (!memoryStore.user_dependencies) memoryStore.user_dependencies = [];
    memoryStore.user_dependencies.push({
      id: nextIds.user_dependencies++,
      user_id: userId,
      task_id: dependent_id,
      depends_on_task_id: prerequisite_id,
      confirmed: true,
      created_at: new Date().toISOString()
    });
    memoryStore.task_dependencies.push({ task_id: dependent_id, depends_on_task_id: prerequisite_id });
  }

  patternMatcher.recordPatternFeedback(dep_title || '', prereq_title || '', userId);
  suggestion.accepted = true;

  const userProject = getUserProject(userId);
  const userTasks = memoryStore.tasks.filter(t => t.project_id === userProject.id);
  const newEdges = getUserConfirmedEdges(userId);
  const { tasks: computedTasks } = engine.processGraph(userTasks, newEdges);

  saveToDisk();

  res.json({ success: true, suggestion, tasks: computedTasks });
});

app.post('/api/suggestions/:id/reject', authenticateToken, (req, res) => {
  const suggestionId = Number(req.params.id);
  const suggestion = memoryStore.ai_suggestions.find(s => s.id === suggestionId);

  if (!suggestion) {
    return res.status(404).json({ error: 'Suggestion not found' });
  }

  suggestion.accepted = false;
  saveToDisk();

  res.json({ success: true, suggestion });
});

// GET /api/metrics - Live metrics
app.get('/api/metrics', (req, res) => {
  const total = Math.max(1, metrics.kb_hits + metrics.llm_calls);
  const kbPercentage = metrics.kb_hits === 0 && metrics.llm_calls === 0 
    ? 100 
    : Math.round((metrics.kb_hits / total) * 100);
  const llmPercentage = 100 - kbPercentage;

  res.json({
    kbHits: metrics.kb_hits,
    llmCalls: metrics.llm_calls,
    totalTasksCreated: metrics.total_tasks_created,
    kbPercentage,
    llmPercentage,
    averageLatencyMs: 12
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`TaskFlow Pro API running on port ${PORT}`);
});

module.exports = app;
