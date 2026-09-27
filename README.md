# 🚀 TaskFlowPro: Deterministic DAG & Task Dependency Recommendation Engine

TaskFlowPro is a full-stack, enterprise-grade project management application built with Node.js, Express, React, PostgreSQL, and AI-driven task disambiguation. It combines a **Deterministic Directed Acyclic Graph (DAG) Engine** (using Kahn's algorithm for readiness and topological sorting) with a **3-Layer Task Dependency Recommendation Pipeline** (Fuzzy Trigram Matching → Self-Hosted `all-MiniLM-L6-v2` Vector Embedding Search → Google Gemini 2.5 Flash LLM Fallback).

---

## 🌟 Key Features

### 1. ⚙️ Deterministic DAG Dependency Engine
- **Cycle Detection & Prevention**: Prevents self-loops, 2-node cycles, and multi-node feedback loops in real time using Depth-First Search (DFS).
- **Full-Graph Readiness Calculation**: Uses Kahn's topological sort algorithm to automatically manage task states (`ready`, `blocked`, `in_progress`, `done`).
- **Converging Diamond Dependency Propagation**: Correctly propagates schedule shifts through complex diamond dependency networks without double-counting delays.
- **Rollback Handling**: Regressing a completed prerequisite automatically updates all downstream dependent tasks back to `blocked` status.

### 2. 🧠 3-Layer Task Dependency Recommendation System
Input task names are resolved to canonical tasks through a high-performance 3-layer cascade:

| Layer | Technology | Threshold / Condition | Description |
| :--- | :--- | :--- | :--- |
| **Layer 1: Fuzzy Matching** | `pg_trgm` / Trigram | Similarity $\ge$ `0.85` | Fast, zero-cost typo and abbreviation matching. Strips stopwords and domain action verbs. |
| **Layer 2: Embedding Search** | `all-MiniLM-L6-v2` (ONNX CPU) + `pgvector` | Cosine Similarity $\ge$ `0.80` | Local semantic matching without external API costs. Auto-persists confirmed aliases. |
| **Layer 3: LLM Fallback** | Google Gemini 2.5 Flash | Ambiguous band (`0.55` – `0.80`) | Disambiguates complex or novel task titles. Results require user confirmation before committing. |

### 3. 📊 Historical Pattern Mining
- Aggregates confirmed user dependency sequences into a precomputed pattern library.
- Recommends likely dependencies for new tasks based on historical confidence scores ($Frequency / TotalObservations$).
- Filters out idiosyncratic choices below a configurable sample size threshold (`MIN_PATTERN_SAMPLE_SIZE = 3`).

### 4. 🎨 Modern Interactive Frontend
- **Kanban Board**: Drag-and-drop workflow with real-time prerequisite enforcement (e.g. blocked tasks cannot be moved directly to Done).
- **Interactive DAG Graph**: Visualized using `React-Flow` with auto-layered topological layout.
- **Live Metrics Dashboard**: Tracks AI vs. Knowledge Base suggestion rates, task creation metrics, and system efficiency.

---

## 🏗️ Architecture & Technology Stack

```
TaskFlowPro/
├── backend/                  # Node.js + Express REST API Server
│   ├── src/
│   │   ├── db/               # PostgreSQL Connection, Schema & Migrations
│   │   ├── dependencyEngine/ # Deterministic Graph Engine & 3-Layer Pipeline
│   │   ├── routes/           # REST API Endpoints (/api, /tasks)
│   │   └── services/         # Gemini LLM Integration & Pattern Services
│   └── tests/                # Jest Automated Test Suite (22 Unit & Integration Tests)
└── frontend/                 # Vite + React Modern Web Application
    └── src/
        ├── App.jsx           # Main Kanban, DAG Graph (ReactFlow), & Modals
        └── index.css         # Styling & Custom Animations
```

- **Backend**: Node.js, Express, PostgreSQL (`pg`), `@xenova/transformers` (`all-MiniLM-L6-v2`), `@google/generative-ai` (Gemini 2.5 Flash), JWT Authentication.
- **Database**: PostgreSQL with `pgvector` (384-dimensional vector similarity) and `pg_trgm` (trigram fuzzy matching).
- **Frontend**: React 18, Vite, ReactFlow, Lucide Icons, Tailwind-inspired Vanilla CSS design system.
- **Testing**: Jest framework with mock DB and deterministic vector fallbacks.

---

## 🛠️ Database Schema

The recommendation engine adds five PostgreSQL tables:

```sql
-- 1. Canonical Task Dictionary
CREATE TABLE canonical_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    canonical_name TEXT UNIQUE NOT NULL,
    embedding vector(384),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Task Aliases (User Confirmed & LLM Suggested)
CREATE TABLE task_aliases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    canonical_task_id UUID REFERENCES canonical_tasks(id),
    alias_text TEXT NOT NULL,
    alias_text_normalized TEXT NOT NULL,
    embedding vector(384),
    confidence_score FLOAT DEFAULT 1.0,
    source VARCHAR(50) DEFAULT 'user_confirmed'
);

-- 3. Historical Dependency Graph Edges
CREATE TABLE task_dependencies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id INT NOT NULL,
    task_id UUID REFERENCES canonical_tasks(id),
    depends_on_task_id UUID REFERENCES canonical_tasks(id),
    sequence_order INT DEFAULT 1
);

-- 4. Precomputed Dependency Patterns
CREATE TABLE dependency_patterns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID REFERENCES canonical_tasks(id),
    depends_on_task_id UUID REFERENCES canonical_tasks(id),
    frequency_count INT DEFAULT 1,
    confidence FLOAT DEFAULT 0.0
);

-- 5. Audit Resolution Logs
CREATE TABLE resolution_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    input_text TEXT NOT NULL,
    resolved_canonical_task_id UUID,
    layer VARCHAR(50) NOT NULL,
    similarity_score FLOAT,
    reasoning TEXT
);
```

---

## 🚦 Getting Started

### Prerequisites
- **Node.js**: `v18+` or `v22+`
- **PostgreSQL**: `v14+` with `pgvector` and `pg_trgm` extensions enabled.
- **Google Gemini API Key**: For Layer 3 LLM fallback and AI suggestions.

### 1. Environment Configuration

Create a `.env` file in the `backend/` directory:

```env
PORT=5000
JWT_SECRET=your_jwt_secret_key_2026
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-2.5-flash

# Recommendation System Thresholds
FUZZY_THRESHOLD=0.85
EMBEDDING_HIGH_THRESHOLD=0.80
EMBEDDING_LOW_THRESHOLD=0.55
MIN_PATTERN_SAMPLE_SIZE=3

# PostgreSQL Connection (Optional - defaults to in-memory store if omitted)
PGHOST=localhost
PGPORT=5432
PGDATABASE=taskflowpro
PGUSER=postgres
PGPASSWORD=yourpassword
```

### 2. Backend Setup & Run

```bash
cd backend
npm install
npm run dev
```

### 3. Frontend Setup & Run

```bash
cd frontend
npm install
npm run dev
```

The application will be accessible at `http://localhost:3000`.

---

## 🧪 Running Automated Tests

Run the complete Jest test suite covering cycle detection, topological readiness, fuzzy matching, embedding search, LLM fallback, and pattern suggestions:

```bash
cd backend
npm test
```

Expected Output:
```text
PASS src/dependencyEngine/__tests__/engine.test.js (10 tests)
PASS tests/resolutionPipeline.test.js (12 tests)

Test Suites: 2 passed, 2 total
Tests:       22 passed, 22 total
```

---

## 📡 API Reference

### Task Resolution & Recommendations
- `POST /tasks/resolve`: Resolves raw user input string to a canonical task ID.
- `POST /tasks/confirm-alias`: Confirms an LLM-suggested alias and elevates its confidence to `1.0`.
- `GET /tasks/:id/suggested-dependencies`: Returns historical sequence dependency recommendations for a task.
- `POST /tasks/confirm-dependencies`: Commits confirmed graph edges and updates precomputed pattern frequencies.

### Core Graph & Task Management
- `GET /api/tasks`: Fetches user tasks with calculated status (`ready`, `blocked`, `done`).
- `POST /api/tasks`: Creates a new task with pre-submission cycle validation.
- `PATCH /api/tasks/:id`: Updates task status and recalculates downstream DAG readiness.
- `GET /api/graph`: Returns active DAG graph nodes and edges.
- `POST /api/llm/suggest`: Generates grounded AI dependency suggestions via Gemini 2.5 Flash.

---

## 📄 License

This project is licensed under the **MIT License**.
