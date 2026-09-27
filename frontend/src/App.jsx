import React, { useState, useEffect, useMemo, useCallback } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  MarkerType,
  useNodesState,
  useEdgesState
} from 'reactflow';
import 'reactflow/dist/style.css';

import {
  Kanban, GitCommit, Sparkles, Activity, Plus, CheckCircle2,
  AlertCircle, Clock, Lock, ArrowRight, Trash2, Zap, Cpu,
  ShieldCheck, LogOut, X, LogIn, UserPlus, Bell, ChevronDown
} from 'lucide-react';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
const apiHeaders = (token, json = true) => ({
  ...(json ? { 'Content-Type': 'application/json' } : {}),
  ...(token ? { Authorization: `Bearer ${token}` } : {})
});

// ─────────────────────────────────────────────────────────────
// Custom React-Flow Node
// ─────────────────────────────────────────────────────────────
const statusStyle = {
  ready:       { border: '#10b981', bg: 'rgba(6,78,59,0.8)',   text: '#6ee7b7', badge: '#059669' },
  in_progress: { border: '#f59e0b', bg: 'rgba(78,47,0,0.8)',   text: '#fcd34d', badge: '#d97706' },
  blocked:     { border: '#f43f5e', bg: 'rgba(76,5,25,0.8)',   text: '#fda4af', badge: '#e11d48' },
  done:        { border: '#6366f1', bg: 'rgba(30,27,75,0.8)',  text: '#a5b4fc', badge: '#4f46e5' },
  not_started: { border: '#475569', bg: 'rgba(15,23,42,0.8)', text: '#94a3b8', badge: '#334155' }
};

function TaskNode({ data }) {
  const s = statusStyle[data.status] || statusStyle.not_started;
  return (
    <div style={{
      background: s.bg,
      border: `2px solid ${s.border}`,
      borderRadius: 14,
      padding: '10px 14px',
      minWidth: 200,
      maxWidth: 240,
      boxShadow: `0 0 18px ${s.border}44`,
      fontFamily: 'Inter, sans-serif'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontSize: 9, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: 1 }}>
          #{data.id}
        </span>
        <span style={{
          fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
          background: s.badge, color: '#fff', borderRadius: 4, padding: '2px 6px'
        }}>
          {data.status?.replace('_', ' ')}
        </span>
      </div>
      <div style={{ fontSize: 12, fontWeight: 700, color: '#fff', marginBottom: 4, lineHeight: 1.3 }}>
        {data.label}
      </div>
      <div style={{ fontSize: 10, color: '#94a3b8', fontFamily: 'monospace' }}>
        {data.start_date || 'TBD'} → {data.end_date || 'TBD'}
      </div>
      <div style={{ fontSize: 10, color: s.text, marginTop: 4 }}>
        ⏱ {data.duration}d
      </div>
    </div>
  );
}

const nodeTypes = { taskNode: TaskNode };

// ─────────────────────────────────────────────────────────────
// Topological layer positioning for clean DAG
// ─────────────────────────────────────────────────────────────
function computeLayeredLayout(tasks, edges) {
  if (!tasks.length) return {};
  const taskIds = new Set(tasks.map(t => String(t.id)));

  // build adj list
  const children = {};  // parent -> [children]
  const parentCount = {};
  tasks.forEach(t => { children[t.id] = []; parentCount[t.id] = 0; });
  edges.forEach(e => {
    const from = e.depends_on_task_id;
    const to = e.task_id;
    if (children[from] !== undefined) children[from].push(to);
    if (parentCount[to] !== undefined) parentCount[to]++;
  });

  // Kahn's BFS for layers
  const layers = {};
  const queue = tasks.filter(t => parentCount[t.id] === 0).map(t => t.id);
  const visited = new Set();
  let layer = 0;

  while (queue.length) {
    const nextQueue = [];
    queue.forEach(id => {
      if (visited.has(id)) return;
      visited.add(id);
      layers[id] = layer;
      (children[id] || []).forEach(cid => {
        parentCount[cid]--;
        if (parentCount[cid] === 0) nextQueue.push(cid);
      });
    });
    layer++;
    queue.length = 0;
    queue.push(...nextQueue);
  }

  // Any unvisited tasks (cycle remnants) go to last layer
  tasks.forEach(t => { if (layers[t.id] === undefined) layers[t.id] = layer; });

  // Compute positions - group by layer
  const byLayer = {};
  Object.entries(layers).forEach(([id, l]) => {
    if (!byLayer[l]) byLayer[l] = [];
    byLayer[l].push(Number(id));
  });

  const positions = {};
  const X_GAP = 300, Y_GAP = 160;
  Object.entries(byLayer).forEach(([l, ids]) => {
    const totalH = ids.length * Y_GAP;
    ids.forEach((id, i) => {
      positions[id] = {
        x: Number(l) * X_GAP + 60,
        y: i * Y_GAP - totalH / 2 + 320
      };
    });
  });

  return positions;
}

// ── Cycle check helper for pre-submission validation ─────
function checkCycleFrontend(targetTaskId, prereqId, dbEdges) {
  if (!prereqId) return false;
  const pId = Number(prereqId);
  const tId = Number(targetTaskId);
  if (tId === pId) return true;

  const adj = new Map();
  dbEdges.forEach(e => {
    const tid = Number(e.task_id);
    const pid = Number(e.depends_on_task_id);
    if (!adj.has(tid)) adj.set(tid, []);
    adj.get(tid).push(pid);
  });

  if (!adj.has(tId)) adj.set(tId, []);
  adj.get(tId).push(pId);

  const visited = new Set();
  const recStack = new Set();

  function dfs(curr) {
    visited.add(curr);
    recStack.add(curr);
    const neighbors = adj.get(curr) || [];
    for (const n of neighbors) {
      if (!visited.has(n)) {
        if (dfs(n)) return true;
      } else if (recStack.has(n)) {
        return true;
      }
    }
    recStack.delete(curr);
    return false;
  }

  for (const [node] of adj) {
    if (!visited.has(node)) {
      if (dfs(node)) return true;
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────
// Main App
// ─────────────────────────────────────────────────────────────
export default function App() {
  // Auth
  const [authToken, setAuthToken] = useState(() => localStorage.getItem('tf_token'));
  const [user, setUser] = useState(() => {
    const s = localStorage.getItem('tf_user');
    return s ? JSON.parse(s) : null;
  });
  const [authMode, setAuthMode] = useState('login');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authName, setAuthName] = useState('');

  // App data
  const [activeTab, setActiveTab] = useState('kanban');
  const [tasks, setTasks] = useState([]);
  const [dbEdges, setDbEdges] = useState([]);   // raw edges from database
  const [suggestions, setSuggestions] = useState([]);
  const [pendingConfirmations, setPendingConfirmations] = useState([]);
  const [metrics, setMetrics] = useState({ kbHits: 0, llmCalls: 0, totalTasksCreated: 0, kbPercentage: 100, llmPercentage: 0 });
  const [toast, setToast] = useState(null);
  const [loading, setLoading] = useState(false);

  // Task Inputs & Pre-submission Cycle Warning
  const [isNewTaskOpen, setIsNewTaskOpen] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskDesc, setNewTaskDesc] = useState('');
  const [newTaskDuration, setNewTaskDuration] = useState(2);
  const [newTaskPrereqId, setNewTaskPrereqId] = useState('');
  const [cycleWarning, setCycleWarning] = useState(null);

  // DAG Database Matches & 3-Option Action Sheet
  const [dbMatchesList, setDbMatchesList] = useState([]);
  const [isDBMatchModalOpen, setIsDBMatchModalOpen] = useState(false);

  // Gemini LLM 2-Suggestion View
  const [llmSuggestionsList, setLlmSuggestionsList] = useState([]);
  const [isLLMModalOpen, setIsLLMModalOpen] = useState(false);
  const [llmLoading, setLlmLoading] = useState(false);

  // Edit Dependency Modal
  const [editModalState, setEditModalState] = useState({ isOpen: false, taskId: '', prereqId: '' });

  // Drag state
  const [draggedTaskId, setDraggedTaskId] = useState(null);
  const [dragOverColumn, setDragOverColumn] = useState(null);

  // React-Flow state
  const [rfNodes, setRfNodes, onNodesChange] = useNodesState([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState([]);

  // ── Toast ───────────────────────────────────────────────────
  const showToast = useCallback((message, type = 'info') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 5000);
  }, []);

  // ── Fetch All Data ──────────────────────────────────────────
  const fetchData = useCallback(async () => {
    if (!authToken) return;
    const h = apiHeaders(authToken, false);
    try {
      const [tRes, gRes, mRes] = await Promise.all([
        fetch('/api/tasks', { headers: h }),
        fetch('/api/graph', { headers: h }),
        fetch('/api/metrics', { headers: h })
      ]);

      if (tRes.ok) setTasks(await tRes.json());
      if (gRes.ok) {
        const g = await gRes.json();
        setDbEdges(g.edges || []);
      }
      if (mRes.ok) setMetrics(await mRes.json());
    } catch (err) {
      console.error('Fetch error:', err);
    }
  }, [authToken]);

  const fetchSuggestions = useCallback(async () => {
    if (!authToken) return;
    try {
      const res = await fetch('/api/suggestions', { headers: apiHeaders(authToken, false) });
      if (res.ok) setSuggestions(await res.json());
    } catch {}
  }, [authToken]);

  const fetchPendingConfirmations = useCallback(async () => {
    if (!authToken) return;
    try {
      const res = await fetch('/api/dependency-suggestions', { headers: apiHeaders(authToken, false) });
      if (res.ok) setPendingConfirmations(await res.json());
    } catch {}
  }, [authToken]);

  useEffect(() => {
    if (authToken) { fetchData(); fetchSuggestions(); fetchPendingConfirmations(); }
  }, [authToken]);

  // ── Build React-Flow graph from DB edges ────────────────────
  useEffect(() => {
    if (!tasks.length) { setRfNodes([]); setRfEdges([]); return; }

    const positions = computeLayeredLayout(tasks, dbEdges);

    const nodes = tasks.map(task => ({
      id: String(task.id),
      type: 'taskNode',
      position: positions[task.id] || { x: 60, y: 60 },
      data: {
        id: task.id,
        label: task.title,
        status: task.status,
        start_date: task.start_date,
        end_date: task.end_date,
        duration: task.duration
      }
    }));

    const edges = dbEdges.map((e, i) => ({
      id: `e-${e.depends_on_task_id}-${e.task_id}-${i}`,
      source: String(e.depends_on_task_id),
      sourceHandle: 'bottom',
      target: String(e.task_id),
      targetHandle: 'top',
      animated: true,
      type: 'smoothstep',
      style: { stroke: '#6366f1', strokeWidth: 2.5 },
      markerEnd: { type: MarkerType.ArrowClosed, color: '#6366f1', width: 22, height: 22 },
      label: 'blocks →',
      labelStyle: { fontSize: 9, fill: '#a5b4fc', fontWeight: 700 },
      labelBgStyle: { fill: '#0f172a', fillOpacity: 0.85 }
    }));

    setRfNodes(nodes);
    setRfEdges(edges);
  }, [tasks, dbEdges]);

  // ── AUTH ────────────────────────────────────────────────────
  const handleAuth = async (e) => {
    e.preventDefault();
    setLoading(true);
    const endpoint = authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
    const payload = authMode === 'login'
      ? { email: authEmail, password: authPassword }
      : { name: authName, email: authEmail, password: authPassword };

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (res.ok) {
        setAuthToken(data.token);
        setUser(data.user);
        localStorage.setItem('tf_token', data.token);
        localStorage.setItem('tf_user', JSON.stringify(data.user));
        showToast(`Welcome back, ${data.user.name}! 🚀`, 'success');
      } else {
        showToast(data.error || 'Authentication failed', 'error');
      }
    } catch {
      showToast('Cannot connect to server', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = () => {
    setAuthToken(null); setUser(null);
    setTasks([]); setDbEdges([]); setSuggestions([]);
    localStorage.removeItem('tf_token'); localStorage.removeItem('tf_user');
    showToast('Signed out', 'info');
  };

  // ── STATUS CHANGE ───────────────────────────────────────────
  const handleStatusChange = async (taskId, newStatus) => {
    if (newStatus !== 'blocked') {
      const prereqEdges = dbEdges.filter(ed => Number(ed.task_id) === Number(taskId));
      const unfinished = prereqEdges
        .map(ed => tasks.find(t => Number(t.id) === Number(ed.depends_on_task_id)))
        .filter(t => t && t.status !== 'done');

      if (unfinished.length > 0) {
        showToast(`Task BLOCKED: Complete prerequisite '${unfinished[0].title}' (#${unfinished[0].id}) first!`, 'error');
        return;
      }
    }

    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: apiHeaders(authToken),
        body: JSON.stringify({ status: newStatus })
      });
      const data = await res.json();
      if (res.ok) {
        await fetchData();
        showToast(`Status → ${newStatus.replace('_',' ')}`, 'success');
      } else {
        showToast(data.error || 'Failed updating status', 'error');
      }
    } catch {
      showToast('Error connecting to backend', 'error');
    }
  };

  // ── CREATE TASK (with manual prereq input, cycle check & DAG match score) ─────
  const handleCreateTask = async (e) => {
    e.preventDefault();
    if (!newTaskTitle.trim()) return;

    if (cycleWarning) {
      showToast('Cannot create task: Fix circular dependency first!', 'error');
      return;
    }

    setLoading(true);

    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: apiHeaders(authToken),
        body: JSON.stringify({
          title: newTaskTitle,
          description: newTaskDesc,
          duration: Number(newTaskDuration),
          prerequisite_id: newTaskPrereqId || null
        })
      });
      const data = await res.json();
      if (res.ok) {
        setNewTaskTitle(''); setNewTaskDesc(''); setNewTaskDuration(2); setNewTaskPrereqId(''); setCycleWarning(null);
        setIsNewTaskOpen(false);
        await fetchData();

        if (data.dbMatches && data.dbMatches.length > 0) {
          setDbMatchesList(data.dbMatches);
          setIsDBMatchModalOpen(true);
          showToast(`Task created! DAG system matched ${data.dbMatches.length} dependency pattern(s).`, 'success');
        } else {
          showToast('Task created! No DAG pattern matches found.', 'success');
        }
      } else {
        showToast(data.error || 'Failed to create task', 'error');
      }
    } catch {
      showToast('Error creating task', 'error');
    } finally {
      setLoading(false);
    }
  };

  // ── DAG MATCH ACTION HANDLERS (3 Options: Accept, Edit, Call LLM) ──
  const handleAcceptDBMatch = async (match) => {
    try {
      const res = await fetch('/api/dependencies/edit-and-accept', {
        method: 'POST',
        headers: apiHeaders(authToken),
        body: JSON.stringify({
          task_id: match.dependent_id,
          depends_on_task_id: match.prerequisite_id
        })
      });
      const data = await res.json();
      if (res.ok) {
        await fetchData();
        showToast('Dependency accepted & keywords extracted to DAG database!', 'success');
        setDbMatchesList(prev => prev.filter(m => !(m.dependent_id === match.dependent_id && m.prerequisite_id === match.prerequisite_id)));
      } else {
        showToast(data.error || 'Failed to accept dependency', 'error');
      }
    } catch { showToast('Error confirming dependency', 'error'); }
  };

  const handleOpenEditModal = (taskId, prereqId) => {
    setEditModalState({ isOpen: true, taskId: String(taskId), prereqId: String(prereqId) });
  };

  const handleSaveEditModal = async () => {
    if (!editModalState.taskId || !editModalState.prereqId) return;
    try {
      const res = await fetch('/api/dependencies/edit-and-accept', {
        method: 'POST',
        headers: apiHeaders(authToken),
        body: JSON.stringify({
          task_id: Number(editModalState.taskId),
          depends_on_task_id: Number(editModalState.prereqId)
        })
      });
      const data = await res.json();
      if (res.ok) {
        await fetchData();
        setEditModalState({ isOpen: false, taskId: '', prereqId: '' });
        showToast('Edited dependency saved & keywords extracted to DAG database!', 'success');
      } else {
        showToast(data.error || 'Failed saving edited dependency', 'error');
      }
    } catch { showToast('Error saving edited dependency', 'error'); }
  };

  const handleTriggerLLMApi = async () => {
    setLlmLoading(true);
    try {
      const res = await fetch('/api/llm/suggest', {
        method: 'POST',
        headers: apiHeaders(authToken, false)
      });
      const data = await res.json();
      if (res.ok) {
        setLlmSuggestionsList(data.suggestions || []);
        setIsDBMatchModalOpen(false);
        setIsLLMModalOpen(true);
        showToast('Gemini API returned 2 dependency suggestions!', 'success');
      } else {
        showToast('Failed invoking Gemini LLM', 'error');
      }
    } catch { showToast('Error connecting to LLM service', 'error'); }
    finally { setLlmLoading(false); }
  };

  const handleAcceptLLMSuggestion = async (sug) => {
    try {
      const res = await fetch('/api/dependencies/edit-and-accept', {
        method: 'POST',
        headers: apiHeaders(authToken),
        body: JSON.stringify({
          task_id: sug.payload.dependent_id,
          depends_on_task_id: sug.payload.prerequisite_id
        })
      });
      const data = await res.json();
      if (res.ok) {
        await fetchData();
        showToast('AI suggestion accepted & keywords saved to database!', 'success');
        setLlmSuggestionsList(prev => prev.filter(s => s.payload.dependent_id !== sug.payload.dependent_id || s.payload.prerequisite_id !== sug.payload.prerequisite_id));
      } else {
        showToast(data.error || 'Cannot accept AI suggestion', 'error');
      }
    } catch { showToast('Error confirming AI suggestion', 'error'); }
  };

  // ── PENDING CONFIRMATIONS ───────────────────────────────────
  const handleConfirmSuggestion = async (id) => {
    try {
      const res = await fetch(`/api/dependency-suggestions/${id}/confirm`, {
        method: 'POST', headers: apiHeaders(authToken, false)
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Cannot confirm: cycle detected', 'error');
      } else {
        await fetchData();
        await fetchPendingConfirmations();
        showToast('Dependency confirmed! Graph updated.', 'success');
      }
    } catch { showToast('Error confirming suggestion', 'error'); }
  };

  const handleRejectConfirmation = async (id) => {
    try {
      await fetch(`/api/dependency-suggestions/${id}/reject`, {
        method: 'POST', headers: apiHeaders(authToken, false)
      });
      await fetchPendingConfirmations();
      showToast('Suggestion dismissed.', 'info');
    } catch {}
  };

  // ── DELETE TASK ─────────────────────────────────────────────
  const handleDeleteTask = async (taskId) => {
    try {
      await fetch(`/api/tasks/${taskId}`, {
        method: 'DELETE',
        headers: apiHeaders(authToken, false)
      });
      await fetchData();
      showToast('Task deleted', 'info');
    } catch {
      showToast('Error deleting task', 'error');
    }
  };

  // ── AI SUGGESTIONS ──────────────────────────────────────────
  const handleAcceptSuggestion = async (id) => {
    try {
      const res = await fetch(`/api/suggestions/${id}/accept`, {
        method: 'POST', headers: apiHeaders(authToken, false)
      });
      const data = await res.json();
      if (!res.ok) showToast(data.error || 'Cannot accept', 'error');
      else { await fetchData(); await fetchSuggestions(); showToast('Suggestion accepted & graph updated!', 'success'); }
    } catch { showToast('Error accepting suggestion', 'error'); }
  };

  const handleRejectSuggestion = async (id) => {
    try {
      await fetch(`/api/suggestions/${id}/reject`, { method: 'POST', headers: apiHeaders(authToken, false) });
      await fetchSuggestions();
      showToast('Suggestion dismissed', 'info');
    } catch {}
  };

  // ── DRAG AND DROP ───────────────────────────────────────────
  const handleDragStart = (e, taskId) => {
    setDraggedTaskId(taskId);
    e.dataTransfer.setData('text/plain', String(taskId));
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e, colId) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverColumn(colId);
  };

  const handleDragLeave = () => setDragOverColumn(null);

  const handleDrop = async (e, targetStatus) => {
    e.preventDefault();
    setDragOverColumn(null);

    const taskIdStr = e.dataTransfer.getData('text/plain') || String(draggedTaskId);
    if (!taskIdStr) return;
    const taskId = Number(taskIdStr);
    const task = tasks.find(t => t.id === taskId);
    if (!task || task.status === targetStatus) return;

    // Rule: Blocked task cannot jump directly to done
    if (task.status === 'blocked' && targetStatus === 'done') {
      showToast(`"${task.title}" is Blocked. Complete prerequisites first!`, 'error');
      setDraggedTaskId(null); return;
    }

    // Rule: Moving to done - check all prereqs are done
    if (targetStatus === 'done') {
      const prereqEdges = dbEdges.filter(ed => String(ed.task_id) === String(taskId));
      const unfinished = prereqEdges
        .map(ed => tasks.find(t => String(t.id) === String(ed.depends_on_task_id)))
        .filter(t => t && t.status !== 'done');
      if (unfinished.length > 0) {
        showToast(`Cannot complete "${task.title}" — ${unfinished.length} prerequisite(s) still incomplete!`, 'error');
        setDraggedTaskId(null); return;
      }
    }

    // Rule: ready/in_progress checks
    if (targetStatus === 'ready' || targetStatus === 'in_progress') {
      const prereqEdges = dbEdges.filter(ed => String(ed.task_id) === String(taskId));
      const unfinished = prereqEdges
        .map(ed => tasks.find(t => String(t.id) === String(ed.depends_on_task_id)))
        .filter(t => t && t.status !== 'done');
      if (unfinished.length > 0) {
        showToast(`"${task.title}" has ${unfinished.length} unfinished prerequisite(s). Resolve them first!`, 'error');
        setDraggedTaskId(null); return;
      }
    }

    if (task.status === 'done' && (targetStatus === 'ready' || targetStatus === 'in_progress')) {
      showToast(`Regressing "${task.title}"... recalculating downstream tasks.`, 'info');
    }

    await handleStatusChange(taskId, targetStatus);
    setDraggedTaskId(null);
  };

  // ── COLUMNS ──────────────────────────────────────────────────
  const columns = [
    { id: 'blocked', title: 'Blocked', icon: Lock, color: 'text-rose-400 border-rose-500/30 bg-rose-500/10',
      desc: 'Prerequisites unmet', badge: 'bg-rose-500' },
    { id: 'ready', title: 'Ready / In Progress', icon: CheckCircle2, color: 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10',
      desc: 'Available to work on', badge: 'bg-emerald-500' },
    { id: 'done', title: 'Done', icon: ShieldCheck, color: 'text-indigo-400 border-indigo-500/30 bg-indigo-500/10',
      desc: 'Completed tasks', badge: 'bg-indigo-500' }
  ];

  // ── AUTH SCREEN ─────────────────────────────────────────────
  if (!authToken) {
    return (
      <div className="min-h-screen bg-[#06090f] flex items-center justify-center p-4 relative overflow-hidden">
        {/* Background glow */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-indigo-600/10 rounded-full blur-3xl" />
          <div className="absolute bottom-1/4 right-1/4 w-80 h-80 bg-purple-600/10 rounded-full blur-3xl" />
        </div>

        {toast && (
          <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl shadow-xl flex items-center gap-3 text-sm font-medium ${
            toast.type === 'error' ? 'bg-rose-950 border border-rose-500/50 text-rose-200' : 'bg-indigo-950 border border-indigo-500/50 text-indigo-200'
          }`}>
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            {toast.message}
          </div>
        )}

        <div className="relative w-full max-w-md bg-[#0c1220]/90 backdrop-blur-xl border border-slate-700/50 rounded-2xl p-8 shadow-2xl">
          <div className="text-center mb-8">
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center mx-auto mb-4 shadow-lg shadow-indigo-500/30">
              <GitCommit className="w-7 h-7 text-white" />
            </div>
            <h1 className="text-2xl font-bold text-white mb-1">TaskFlow Pro</h1>
            <p className="text-sm text-slate-400">Deterministic Dependency Engine with PostgreSQL</p>
          </div>

          <div className="flex bg-slate-900/60 p-1 rounded-xl border border-slate-800 mb-6">
            <button onClick={() => setAuthMode('login')}
              className={`flex-1 py-2 rounded-lg text-xs font-semibold transition-all ${authMode === 'login' ? 'bg-indigo-600 text-white shadow' : 'text-slate-400 hover:text-white'}`}>
              <LogIn className="w-3.5 h-3.5 inline mr-1.5" />Sign In
            </button>
            <button onClick={() => setAuthMode('register')}
              className={`flex-1 py-2 rounded-lg text-xs font-semibold transition-all ${authMode === 'register' ? 'bg-indigo-600 text-white shadow' : 'text-slate-400 hover:text-white'}`}>
              <UserPlus className="w-3.5 h-3.5 inline mr-1.5" />Register
            </button>
          </div>

          <form onSubmit={handleAuth} className="space-y-4">
            {authMode === 'register' && (
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">Full Name</label>
                <input type="text" required value={authName} onChange={e => setAuthName(e.target.value)}
                  placeholder="Nishant Kumar"
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition-colors" />
              </div>
            )}
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">Email Address</label>
              <input type="email" required value={authEmail} onChange={e => setAuthEmail(e.target.value)}
                placeholder="you@taskflow.pro"
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition-colors" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1.5">Password</label>
              <input type="password" required value={authPassword} onChange={e => setAuthPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition-colors" />
            </div>
            <button type="submit" disabled={loading}
              className="w-full py-2.5 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white rounded-xl text-sm font-semibold shadow-lg transition-all disabled:opacity-50">
              {loading ? 'Please wait…' : authMode === 'login' ? 'Sign In to Workspace' : 'Create Account'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // ── MAIN APP ─────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#06090f] flex flex-col">
      {/* Toast */}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 max-w-sm px-4 py-3 rounded-xl shadow-2xl border flex items-start gap-3 text-sm font-medium backdrop-blur-sm transition-all duration-300 ${
          toast.type === 'error' ? 'bg-rose-950/95 border-rose-500/50 text-rose-100' :
          toast.type === 'success' ? 'bg-emerald-950/95 border-emerald-500/50 text-emerald-100' :
          'bg-indigo-950/95 border-indigo-500/50 text-indigo-100'
        }`}>
          {toast.type === 'error'
            ? <AlertCircle className="w-4 h-4 text-rose-400 mt-0.5 flex-shrink-0" />
            : <Sparkles className="w-4 h-4 text-indigo-400 mt-0.5 flex-shrink-0" />}
          <span>{toast.message}</span>
        </div>
      )}

      {/* ── NAVBAR ────────────────────────────────────────────── */}
      <header className="sticky top-0 z-40 border-b border-slate-800 bg-[#0c121e]/80 backdrop-blur-lg px-6 py-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 flex-shrink-0">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
            <GitCommit className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-base font-bold text-white leading-none flex items-center gap-2">
              TaskFlow Pro
              <span className="text-[9px] uppercase tracking-widest px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 font-bold">
                PostgreSQL · DAG Engine
              </span>
            </h1>
            <p className="text-[11px] text-slate-500 mt-0.5">{user?.name}'s Workspace</p>
          </div>
        </div>

        <nav className="flex items-center bg-slate-900/70 border border-slate-800 p-1 rounded-xl">
          {[
            { id: 'kanban',   icon: Kanban,    label: 'Kanban' },
            { id: 'dag',      icon: GitCommit, label: 'DAG Graph' },
            { id: 'pending',  icon: Bell,      label: 'Confirmations', badge: pendingConfirmations.length, badgeColor: 'bg-amber-500' },
            { id: 'ai',       icon: Sparkles,  label: 'AI Suggestions', badge: suggestions.length, badgeColor: 'bg-purple-500' },
            { id: 'metrics',  icon: Activity,  label: 'Efficiency' }
          ].map(tab => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)}
              className={`relative flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                activeTab === tab.id ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30' : 'text-slate-400 hover:text-white'
              }`}>
              <tab.icon className="w-3.5 h-3.5" />
              {tab.label}
              {tab.badge > 0 && (
                <span className={`absolute -top-1 -right-1 w-4 h-4 rounded-full ${tab.badgeColor || 'bg-purple-500'} text-white text-[9px] font-bold flex items-center justify-center`}>
                  {tab.badge}
                </span>
              )}
            </button>
          ))}
        </nav>

        <div className="flex items-center gap-2 flex-shrink-0">
          <button onClick={() => setIsNewTaskOpen(true)}
            className="flex items-center gap-1.5 px-3.5 py-2 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white rounded-xl text-xs font-semibold shadow-lg transition-all">
            <Plus className="w-3.5 h-3.5" /> New Task
          </button>
          <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-900 rounded-xl border border-slate-800">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-purple-500 to-indigo-500 flex items-center justify-center text-xs font-bold text-white">
              {user?.name?.charAt(0) || 'U'}
            </div>
            <span className="text-xs font-medium text-slate-200 hidden md:block">{user?.name}</span>
          </div>
          <button onClick={handleLogout}
            className="p-2 bg-slate-900 hover:bg-rose-900/50 text-slate-400 hover:text-rose-300 rounded-xl border border-slate-800 transition-all"
            title="Sign Out">
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* ── MAIN CONTENT ──────────────────────────────────────── */}
      <main className="flex-1 p-6">

        {/* ── KANBAN ──────────────────────────────────────────── */}
        {activeTab === 'kanban' && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5 min-h-[calc(100vh-130px)]">
            {columns.map(col => {
              const colTasks = tasks.filter(t =>
                col.id === 'ready'
                  ? (t.status === 'ready' || t.status === 'in_progress' || t.status === 'not_started')
                  : t.status === col.id
              );
              const ColIcon = col.icon;
              const isOver = dragOverColumn === col.id;

              return (
                <div key={col.id}
                  onDragOver={e => handleDragOver(e, col.id)}
                  onDragLeave={handleDragLeave}
                  onDrop={e => handleDrop(e, col.id === 'ready' ? 'ready' : col.id)}
                  className={`flex flex-col bg-[#0d1424] border rounded-2xl p-4 transition-all duration-200 ${
                    isOver ? 'border-indigo-500 ring-2 ring-indigo-500/20 bg-[#121c33] scale-[1.01]' : 'border-slate-800'
                  }`}>

                  <div className="flex items-center justify-between mb-4 pb-3 border-b border-slate-800">
                    <div className="flex items-center gap-2">
                      <span className={`p-1.5 rounded-lg border ${col.color}`}>
                        <ColIcon className="w-3.5 h-3.5" />
                      </span>
                      <div>
                        <h2 className="font-semibold text-slate-100 text-sm">{col.title}</h2>
                        <p className="text-[10px] text-slate-500">{col.desc}</p>
                      </div>
                    </div>
                    <span className={`text-xs font-bold px-2.5 py-1 rounded-full text-white ${col.badge}`}>
                      {colTasks.length}
                    </span>
                  </div>

                  <div className="flex-1 space-y-3 overflow-y-auto min-h-[180px]">
                    {colTasks.length === 0 && (
                      <div className="h-24 flex items-center justify-center border-2 border-dashed border-slate-800 rounded-xl">
                        <p className="text-slate-600 text-xs">Drop tasks here</p>
                      </div>
                    )}
                    {colTasks.map((task, taskIndex) => {
                      const prereqEdges = dbEdges.filter(e => String(e.task_id) === String(task.id));
                      const isBeingDragged = draggedTaskId === task.id;

                      const taskCard = (
                        <div draggable
                          onDragStart={e => handleDragStart(e, task.id)}
                          className={`bg-[#111827] border border-slate-800 hover:border-indigo-500/40 p-4 rounded-xl shadow-lg transition-all group cursor-grab active:cursor-grabbing ${
                            isBeingDragged ? 'opacity-30 scale-95 border-dashed border-indigo-500' : 'hover:bg-[#162038]'
                          }`}>

                          <div className="flex items-start justify-between gap-2 mb-2">
                            <div className="flex items-start gap-2 flex-1 min-w-0">
                              <span className="text-slate-600 text-xs mt-0.5 flex-shrink-0">⋮⋮</span>
                              <h3 className="font-semibold text-slate-100 text-sm leading-tight">{task.title}</h3>
                            </div>
                            <button onClick={() => handleDeleteTask(task.id)}
                              className="opacity-0 group-hover:opacity-100 text-slate-600 hover:text-rose-400 transition-all flex-shrink-0">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>

                          {task.description && (
                            <p className="text-xs text-slate-400 mb-3 leading-relaxed line-clamp-2">{task.description}</p>
                          )}

                          <div className="flex items-center justify-between mb-3">
                            <span className="text-[10px] text-slate-500 bg-slate-900 px-2 py-0.5 rounded border border-slate-800 flex items-center gap-1">
                              <Clock className="w-2.5 h-2.5" />
                              {task.duration}d &bull; {task.start_date || 'TBD'}
                            </span>
                            {task.status === 'in_progress' && (
                              <span className="text-[9px] font-bold px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 uppercase tracking-wider">
                                In Progress
                              </span>
                            )}
                            {task.status === 'not_started' && (
                              <span className="text-[9px] font-bold px-2 py-0.5 rounded bg-slate-700/50 text-slate-400 border border-slate-700 uppercase tracking-wider">
                                New
                              </span>
                            )}
                          </div>

                          {prereqEdges.length > 0 && (
                            <div className="mb-3 pt-2 border-t border-slate-800/60">
                              <p className="text-[10px] uppercase font-bold text-slate-500 mb-1.5 tracking-wider">Prerequisites</p>
                              <div className="space-y-1">
                                {prereqEdges.map(edge => {
                                  const pt = tasks.find(t => String(t.id) === String(edge.depends_on_task_id));
                                  return (
                                    <div key={edge.depends_on_task_id}
                                      className="flex items-center justify-between text-[11px] bg-slate-900/60 px-2 py-1 rounded-lg border border-slate-800">
                                      <span className="text-slate-300 truncate max-w-[150px]">
                                        {pt ? pt.title : `#${edge.depends_on_task_id}`}
                                      </span>
                                      <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                                        pt?.status === 'done' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'
                                      }`}>{pt?.status || '?'}</span>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}

                          {task.status !== 'blocked' && (
                            <div className="flex items-center gap-1.5 pt-2 border-t border-slate-800/50">
                              <button
                                onClick={() => handleStatusChange(task.id, task.status === 'in_progress' ? 'ready' : 'in_progress')}
                                className={`flex-1 text-[10px] font-bold py-1 rounded-lg transition-all ${
                                  task.status === 'in_progress'
                                    ? 'bg-amber-600/30 text-amber-300 border border-amber-600/40'
                                    : 'bg-slate-800 hover:bg-slate-700 text-slate-400'
                                }`}>
                                {task.status === 'in_progress' ? '↩ Unmark IP' : '▶ Start'}
                              </button>
                              <button
                                onClick={() => handleStatusChange(task.id, 'done')}
                                className="flex-1 text-[10px] font-bold py-1 rounded-lg bg-indigo-600/30 hover:bg-indigo-600/50 text-indigo-300 border border-indigo-600/40 transition-all">
                                ✓ Done
                              </button>
                            </div>
                          )}
                          {task.status === 'blocked' && (
                            <div className="text-[10px] text-rose-400 text-center pt-2 border-t border-slate-800/50 italic">
                              🔒 Complete prerequisites to unlock
                            </div>
                          )}
                        </div>
                      );

                      return (
                        <React.Fragment key={task.id}>
                          {taskCard}
                          {taskIndex < colTasks.length - 1 && (
                            <div className="flex items-center justify-center py-0.5">
                              <div className="flex flex-col items-center gap-0.5">
                                <div className="w-px h-3 bg-slate-700" />
                                <ChevronDown className="w-3 h-3 text-slate-700" />
                              </div>
                            </div>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ── DAG GRAPH (React-Flow from DB edges) ─────────────── */}
        {activeTab === 'dag' && (
          <div className="bg-[#0c1220] border border-slate-800 rounded-2xl p-6 flex flex-col" style={{ height: 'calc(100vh - 140px)' }}>
            <div className="flex items-center justify-between mb-4 pb-3 border-b border-slate-800">
              <div>
                <h2 className="text-lg font-bold text-white flex items-center gap-2">
                  <GitCommit className="w-5 h-5 text-indigo-400" />
                  Dependency DAG — Live from Database
                </h2>
                <p className="text-xs text-slate-400">Arrows point from prerequisite → dependent task. Edges loaded from PostgreSQL.</p>
              </div>
              <div className="flex gap-3 text-[11px] font-semibold">
                {Object.entries(statusStyle).map(([k, s]) => (
                  <span key={k} className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ background: s.border }} />
                    <span style={{ color: s.text }}>{k.replace('_',' ')}</span>
                  </span>
                ))}
              </div>
            </div>

            <div className="flex-1 border border-slate-800 rounded-xl overflow-hidden bg-[#080d18]">
              {tasks.length === 0 ? (
                <div className="h-full flex items-center justify-center text-slate-500 text-sm">
                  No tasks yet — create tasks to see the dependency graph.
                </div>
              ) : (
                <ReactFlow
                  nodes={rfNodes}
                  edges={rfEdges}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  nodeTypes={nodeTypes}
                  fitView
                  fitViewOptions={{ padding: 0.3 }}
                >
                  <Background color="#1e293b" gap={20} size={1} />
                  <Controls className="bg-slate-900 border-slate-700" />
                  <MiniMap
                    nodeColor={({ data }) => statusStyle[data?.status]?.border || '#475569'}
                    style={{ background: '#0f172a', border: '1px solid #1e293b' }}
                  />
                </ReactFlow>
              )}
            </div>
          </div>
        )}

        {/* ── PENDING CONFIRMATIONS ─────────────────────────────── */}
        {activeTab === 'pending' && (
          <div className="max-w-3xl mx-auto">
            <div className="bg-[#0c1220] border border-slate-800 rounded-2xl p-6">
              <h2 className="text-lg font-bold text-white flex items-center gap-2 mb-1">
                <Bell className="w-5 h-5 text-amber-400" />
                Pending Dependency Confirmations
              </h2>
              <p className="text-xs text-slate-400 mb-6">
                The system detected these potential dependencies when you created tasks. Review and confirm or reject each one.
              </p>

              {pendingConfirmations.length === 0 ? (
                <div className="text-center p-10 bg-slate-900/50 rounded-xl border border-slate-800">
                  <ShieldCheck className="w-10 h-10 text-emerald-400 mx-auto mb-3" />
                  <h3 className="font-semibold text-slate-200 mb-1">All Clear!</h3>
                  <p className="text-xs text-slate-400">No pending dependency confirmations. Create tasks to generate suggestions.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {pendingConfirmations.map(r => (
                    <div key={r.id} className="bg-[#121929] border border-amber-500/20 p-5 rounded-xl">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <span className={`text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full inline-block mb-3 ${
                            r.source === 'kb'
                              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                              : 'bg-purple-500/20 text-purple-300 border border-purple-500/30'
                          }`}>
                            {r.source === 'kb' ? '⚡ KB Pattern Match' : '✨ AI Suggestion'}
                          </span>
                          <div className="flex items-center gap-2 text-sm font-semibold text-white mb-2 flex-wrap">
                            <span className="bg-indigo-900/60 border border-indigo-700/50 px-2.5 py-1 rounded-lg">
                              {r.dep_task_title || `#${r.dep_task_id}`}
                            </span>
                            <span className="text-slate-500 text-xs">blocks</span>
                            <ArrowRight className="w-4 h-4 text-amber-400 flex-shrink-0" />
                            <span className="bg-slate-800 border border-slate-700 px-2.5 py-1 rounded-lg">
                              {r.task_title || `#${r.task_id}`}
                            </span>
                          </div>
                          <p className="text-xs text-slate-400 leading-relaxed">{r.reasoning}</p>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <button onClick={() => handleRejectConfirmation(r.id)}
                            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-semibold border border-slate-700 transition-all">
                            Reject
                          </button>
                          <button onClick={() => handleConfirmSuggestion(r.id)}
                            className="px-4 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded-lg text-xs font-semibold shadow-md shadow-amber-600/30 transition-all flex items-center gap-1.5">
                            <CheckCircle2 className="w-3.5 h-3.5" /> Confirm
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── AI SUGGESTIONS ───────────────────────────────────── */}
        {activeTab === 'ai' && (
          <div className="max-w-3xl mx-auto">
            <div className="bg-[#0c1220] border border-slate-800 rounded-2xl p-6">
              <h2 className="text-lg font-bold text-white flex items-center gap-2 mb-1">
                <Sparkles className="w-5 h-5 text-purple-400" />
                AI Dependency Suggestions
              </h2>
              <p className="text-xs text-slate-400 mb-6">
                Matched from your historical KB patterns first. Falls back to Gemini LLM if no match found.
              </p>

              {suggestions.length === 0 ? (
                <div className="text-center p-10 bg-slate-900/50 rounded-xl border border-slate-800">
                  <ShieldCheck className="w-10 h-10 text-emerald-400 mx-auto mb-3" />
                  <h3 className="font-semibold text-slate-200 mb-1">Graph Fully Optimized</h3>
                  <p className="text-xs text-slate-400">No missing dependency suggestions at this time.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {suggestions.map(s => (
                    <div key={s.id} className="bg-[#121929] border border-purple-500/20 p-5 rounded-xl">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <span className={`text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full inline-block mb-3 ${
                            s.source === 'knowledge_base'
                              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                              : 'bg-purple-500/20 text-purple-300 border border-purple-500/30'
                          }`}>
                            {s.source === 'knowledge_base' ? '⚡ KB Pattern Match' : '✨ Gemini LLM'}
                          </span>
                          <div className="flex items-center gap-2 text-sm font-semibold text-white mb-2 flex-wrap">
                            <span className="bg-slate-800 px-2 py-1 rounded">{s.payload.prereq_title || `#${s.payload.prerequisite_id}`}</span>
                            <ArrowRight className="w-4 h-4 text-purple-400 flex-shrink-0" />
                            <span className="bg-slate-800 px-2 py-1 rounded">{s.payload.dep_title || `#${s.payload.dependent_id}`}</span>
                          </div>
                          <p className="text-xs text-slate-400 leading-relaxed">{s.payload.reasoning}</p>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <button onClick={() => handleRejectSuggestion(s.id)}
                            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-semibold border border-slate-700 transition-all">
                            Dismiss
                          </button>
                          <button onClick={() => handleAcceptSuggestion(s.id)}
                            className="px-4 py-1.5 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-xs font-semibold shadow-md shadow-purple-600/30 transition-all flex items-center gap-1.5">
                            <CheckCircle2 className="w-3.5 h-3.5" /> Accept
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── EFFICIENCY METRICS ───────────────────────────────── */}
        {activeTab === 'metrics' && (
          <div className="max-w-3xl mx-auto space-y-6">
            <div className="bg-[#0c1220] border border-slate-800 rounded-2xl p-6">
              <h2 className="text-lg font-bold text-white flex items-center gap-2 mb-1">
                <Activity className="w-5 h-5 text-indigo-400" />
                Real System Efficiency
              </h2>
              <p className="text-xs text-slate-400 mb-6">
                Measures actual KB hits (tasks created with auto-detected dependencies, no LLM call) vs LLM API fallbacks.
              </p>

              <div className="grid grid-cols-3 gap-4 mb-6">
                {[
                  { label: 'KB Auto-Hits', value: metrics.kbHits, sub: 'Dependencies resolved without LLM', color: 'text-emerald-400', icon: Zap, ic: 'text-emerald-400' },
                  { label: 'LLM API Calls', value: metrics.llmCalls, sub: 'Gemini fallback calls made', color: 'text-purple-400', icon: Cpu, ic: 'text-purple-400' },
                  { label: 'Tasks Created', value: metrics.totalTasksCreated || tasks.length, sub: 'Total in your workspace', color: 'text-indigo-400', icon: ShieldCheck, ic: 'text-indigo-400' }
                ].map(m => (
                  <div key={m.label} className="bg-slate-900/60 border border-slate-800 p-5 rounded-xl">
                    <div className="flex items-center gap-2 text-xs text-slate-400 mb-2">
                      <m.icon className={`w-3.5 h-3.5 ${m.ic}`} />
                      {m.label}
                    </div>
                    <div className={`text-3xl font-bold ${m.color} mb-1`}>{m.value}</div>
                    <div className="text-[10px] text-slate-500">{m.sub}</div>
                  </div>
                ))}
              </div>

              <div className="space-y-2">
                <div className="flex justify-between text-xs font-semibold">
                  <span className="text-emerald-400">KB Auto-Hit Rate: {metrics.kbPercentage}%</span>
                  <span className="text-purple-400">LLM Fallback: {metrics.llmPercentage}%</span>
                </div>
                <div className="h-5 bg-slate-900 rounded-full overflow-hidden flex border border-slate-800">
                  <div style={{ width: `${metrics.kbPercentage}%` }}
                    className="bg-gradient-to-r from-emerald-500 to-emerald-400 h-full transition-all duration-700 rounded-l-full" />
                  <div style={{ width: `${metrics.llmPercentage}%` }}
                    className="bg-gradient-to-r from-purple-600 to-purple-500 h-full transition-all duration-700 rounded-r-full" />
                </div>
                <p className="text-[10px] text-slate-500">
                  Goal: ≥70% KB auto-hit rate. Concept words from accepted suggestions are indexed to improve future hit rate.
                </p>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* ── NEW TASK MODAL ─────────────────────────────────────── */}
      {isNewTaskOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#0c1220] border border-slate-700 rounded-2xl w-full max-w-md p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-5 pb-4 border-b border-slate-800">
              <div>
                <h3 className="font-bold text-white text-base">Create New Task</h3>
                <p className="text-xs text-slate-400 mt-0.5">Enter details. DAG system calculates keyword match scores (%)</p>
              </div>
              <button onClick={() => { setIsNewTaskOpen(false); setCycleWarning(null); }} className="text-slate-500 hover:text-white transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreateTask} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">Task Title *</label>
                <input type="text" required value={newTaskTitle} onChange={e => setNewTaskTitle(e.target.value)}
                  placeholder="e.g. Implement Auth Middleware"
                  className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition-colors" />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">Description</label>
                <textarea value={newTaskDesc} onChange={e => setNewTaskDesc(e.target.value)}
                  placeholder="Task scope, technical details, API specs..."
                  rows={2}
                  className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition-colors resize-none" />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">Time (Duration in Days)</label>
                  <input type="number" min="1" max="90" value={newTaskDuration} onChange={e => setNewTaskDuration(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500 transition-colors" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">Prerequisite (Optional)</label>
                  <select value={newTaskPrereqId}
                    onChange={e => {
                      const val = e.target.value;
                      setNewTaskPrereqId(val);
                      if (val) {
                        const isCycle = checkCycleFrontend(99999, val, dbEdges);
                        if (isCycle) setCycleWarning('⚠️ Circular dependency detected! Choosing this prerequisite forms a loop.');
                        else setCycleWarning(null);
                      } else { setCycleWarning(null); }
                    }}
                    className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-white focus:outline-none focus:border-indigo-500 transition-colors">
                    <option value="">None (Auto-match via DAG)</option>
                    {tasks.map(t => (
                      <option key={t.id} value={t.id}>#{t.id} - {t.title}</option>
                    ))}
                  </select>
                </div>
              </div>

              {cycleWarning && (
                <div className="p-3 rounded-xl bg-rose-950/80 border border-rose-500/50 flex items-center gap-2 text-rose-300 text-xs font-medium">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 text-rose-400" />
                  <span>{cycleWarning}</span>
                </div>
              )}

              <div className="p-3 rounded-xl bg-indigo-950/40 border border-indigo-500/20 flex items-start gap-2.5">
                <Zap className="w-4 h-4 text-indigo-400 mt-0.5 flex-shrink-0" />
                <p className="text-xs text-indigo-300 leading-relaxed">
                  <strong>DAG Pattern Engine:</strong> Submitting searches local database for concept matches and returns confidence scores (%). You can Accept, Edit, or Call Gemini LLM for suggestions.
                </p>
              </div>

              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={() => { setIsNewTaskOpen(false); setCycleWarning(null); }}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold transition-all">
                  Cancel
                </button>
                <button type="submit" disabled={loading || !!cycleWarning}
                  className="px-5 py-2 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white rounded-xl text-xs font-semibold shadow-md transition-all disabled:opacity-50">
                  {loading ? 'Creating…' : '⚡ Submit to DAG System'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── DAG DATABASE MATCHES MODAL (3 Options Action Sheet) ── */}
      {isDBMatchModalOpen && dbMatchesList.length > 0 && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#0c1220] border border-amber-500/30 rounded-2xl w-full max-w-2xl p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4 pb-3 border-b border-slate-800">
              <div>
                <span className="text-[10px] font-bold uppercase tracking-widest px-2.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30 mb-1 inline-block">
                  ⚡ DAG Pattern Database Match
                </span>
                <h3 className="font-bold text-white text-base">Detected Task Dependencies</h3>
                <p className="text-xs text-slate-400 mt-0.5">Matched from local DAG pattern database. Sorted by confidence score.</p>
              </div>
              <button onClick={() => setIsDBMatchModalOpen(false)} className="text-slate-500 hover:text-white transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
              {dbMatchesList.map((match, idx) => (
                <div key={idx} className="bg-[#121929] border border-slate-700 p-4 rounded-xl flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm font-semibold text-white flex-wrap">
                      <span className="bg-indigo-900/60 border border-indigo-700 px-2.5 py-1 rounded-lg">
                        {match.prereq_title || `#${match.prerequisite_id}`}
                      </span>
                      <span className="text-xs text-slate-500">blocks</span>
                      <ArrowRight className="w-4 h-4 text-amber-400 flex-shrink-0" />
                      <span className="bg-slate-800 border border-slate-700 px-2.5 py-1 rounded-lg">
                        {match.dep_title || `#${match.dependent_id}`}
                      </span>
                    </div>
                    <span className="px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 text-xs font-bold shadow-sm">
                      {match.match_score_pct}% Match Score
                    </span>
                  </div>

                  <p className="text-xs text-slate-400 leading-relaxed bg-slate-900/60 p-2.5 rounded-lg border border-slate-800/80">
                    {match.reasoning}
                  </p>

                  <div className="flex items-center justify-end gap-2 pt-1 border-t border-slate-800">
                    <button onClick={() => handleOpenEditModal(match.dependent_id, match.prerequisite_id)}
                      className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-semibold border border-slate-700 transition-all flex items-center gap-1">
                      ✏️ Edit Dependencies
                    </button>
                    <button onClick={handleTriggerLLMApi} disabled={llmLoading}
                      className="px-3 py-1.5 bg-purple-900/60 hover:bg-purple-800 text-purple-200 rounded-lg text-xs font-semibold border border-purple-700 transition-all flex items-center gap-1 disabled:opacity-50">
                      <Sparkles className="w-3.5 h-3.5 text-purple-300" />
                      {llmLoading ? 'Calling Gemini...' : 'Call LLM API'}
                    </button>
                    <button onClick={() => handleAcceptDBMatch(match)}
                      className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold shadow-md shadow-emerald-600/30 transition-all flex items-center gap-1.5">
                      <CheckCircle2 className="w-3.5 h-3.5" /> Accept Dependencies
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── GEMINI LLM 2-SUGGESTION VIEW MODAL ────────────────── */}
      {isLLMModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#0c1220] border border-purple-500/40 rounded-2xl w-full max-w-2xl p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4 pb-3 border-b border-slate-800">
              <div>
                <span className="text-[10px] font-bold uppercase tracking-widest px-2.5 py-0.5 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/30 mb-1 inline-flex items-center gap-1">
                  <Sparkles className="w-3 h-3 text-purple-400" /> Gemini LLM API Suggestions
                </span>
                <h3 className="font-bold text-white text-base">2 AI Grounded Suggestions</h3>
                <p className="text-xs text-slate-400 mt-0.5">Choose to Accept, Edit, or Reject. Accepted suggestions train our local DAG matcher.</p>
              </div>
              <button onClick={() => setIsLLMModalOpen(false)} className="text-slate-500 hover:text-white transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            {llmSuggestionsList.length === 0 ? (
              <div className="text-center p-8 bg-slate-900/50 rounded-xl border border-slate-800">
                <ShieldCheck className="w-10 h-10 text-emerald-400 mx-auto mb-2" />
                <p className="text-xs text-slate-300">No additional suggestions returned by Gemini.</p>
              </div>
            ) : (
              <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
                {llmSuggestionsList.map((sug, i) => (
                  <div key={i} className="bg-[#121929] border border-purple-500/30 p-4 rounded-xl flex flex-col gap-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-sm font-semibold text-white flex-wrap">
                        <span className="bg-purple-950 border border-purple-700/60 px-2.5 py-1 rounded-lg">
                          {sug.payload.prereq_title || `#${sug.payload.prerequisite_id}`}
                        </span>
                        <span className="text-xs text-slate-500">blocks</span>
                        <ArrowRight className="w-4 h-4 text-purple-400 flex-shrink-0" />
                        <span className="bg-slate-800 border border-slate-700 px-2.5 py-1 rounded-lg">
                          {sug.payload.dep_title || `#${sug.payload.dependent_id}`}
                        </span>
                      </div>
                      <span className="px-3 py-1 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/40 text-xs font-bold">
                        {sug.payload.match_score_pct || 88}% Confidence
                      </span>
                    </div>

                    <p className="text-xs text-slate-400 leading-relaxed bg-slate-900/60 p-2.5 rounded-lg border border-slate-800/80">
                      {sug.payload.reasoning}
                    </p>

                    <div className="flex items-center justify-end gap-2 pt-1 border-t border-slate-800">
                      <button onClick={() => {
                        setLlmSuggestionsList(prev => prev.filter((_, idx) => idx !== i));
                      }}
                        className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-400 rounded-lg text-xs font-semibold border border-slate-700 transition-all">
                        Reject
                      </button>
                      <button onClick={() => handleOpenEditModal(sug.payload.dependent_id, sug.payload.prerequisite_id)}
                        className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-semibold border border-slate-700 transition-all">
                        Edit
                      </button>
                      <button onClick={() => handleAcceptLLMSuggestion(sug)}
                        className="px-4 py-1.5 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-xs font-semibold shadow-md shadow-purple-600/30 transition-all flex items-center gap-1.5">
                        <CheckCircle2 className="w-3.5 h-3.5" /> Accept Suggestion
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── EDIT DEPENDENCY DIALOG MODAL ───────────────────────── */}
      {editModalState.isOpen && (
        <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#0c1220] border border-slate-700 rounded-2xl w-full max-w-md p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4 pb-3 border-b border-slate-800">
              <h3 className="font-bold text-white text-base">Edit Dependency Pair</h3>
              <button onClick={() => setEditModalState({ isOpen: false, taskId: '', prereqId: '' })} className="text-slate-500 hover:text-white transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">Prerequisite Task (Blocks first)</label>
                <select value={editModalState.prereqId}
                  onChange={e => setEditModalState(prev => ({ ...prev, prereqId: e.target.value }))}
                  className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3.5 py-2.5 text-xs text-white focus:outline-none focus:border-indigo-500 transition-colors">
                  <option value="">Select Prerequisite Task</option>
                  {tasks.map(t => (
                    <option key={t.id} value={t.id}>#{t.id} - {t.title}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">Dependent Task (Runs after prerequisite)</label>
                <select value={editModalState.taskId}
                  onChange={e => setEditModalState(prev => ({ ...prev, taskId: e.target.value }))}
                  className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3.5 py-2.5 text-xs text-white focus:outline-none focus:border-indigo-500 transition-colors">
                  <option value="">Select Dependent Task</option>
                  {tasks.map(t => (
                    <option key={t.id} value={t.id}>#{t.id} - {t.title}</option>
                  ))}
                </select>
              </div>

              <div className="p-3 rounded-xl bg-slate-900 border border-slate-800 text-xs text-slate-400">
                Saving will extract keywords from both tasks and index them into the local DAG pattern store for future matching.
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setEditModalState({ isOpen: false, taskId: '', prereqId: '' })}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold transition-all">
                  Cancel
                </button>
                <button type="button" onClick={handleSaveEditModal}
                  className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-semibold shadow-md transition-all">
                  Confirm & Extract Keywords
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
