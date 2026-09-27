/**
 * Unit & Integration Tests for Task Dependency Recommendation System
 * Covers: Exact match, Fuzzy match, High-confidence embedding match, Ambiguous LLM fallback, No-match creation, and Dependency pattern aggregation.
 */

const { normalizeText, computeTrigramSimilarity, normalize_and_fuzzy_match } = require('../src/dependencyEngine/layer1Fuzzy');
const { embedding_match, cosineSimilarity } = require('../src/dependencyEngine/layer2Embedding');
const { MockLLMProvider } = require('../src/dependencyEngine/llmFallback');
const { resolveTaskName, confirmAlias } = require('../src/dependencyEngine/resolutionPipeline');
const { getSuggestedDependencies, confirmDependencies } = require('../src/dependencyEngine/dependencySuggestion');

describe('Task Dependency Recommendation System Test Suite', () => {
  let mockDbContext;

  beforeEach(() => {
    // Reset test database mock before each test case
    mockDbContext = {
      canonical_tasks: [
        {
          id: 'c-uuid-1',
          canonical_name: 'Database Setup',
          // Pre-computed normalized mock vector for "Database Setup"
          embedding: Array(384).fill(0.1),
          created_at: new Date().toISOString()
        },
        {
          id: 'c-uuid-2',
          canonical_name: 'Authentication Module',
          embedding: Array(384).fill(-0.1),
          created_at: new Date().toISOString()
        }
      ],
      task_aliases: [
        {
          id: 'a-uuid-1',
          canonical_task_id: 'c-uuid-1',
          alias_text: 'Database Setup',
          alias_text_normalized: 'database setup',
          embedding: Array(384).fill(0.1),
          confidence_score: 1.0,
          source: 'user_confirmed',
          created_at: new Date().toISOString()
        },
        {
          id: 'a-uuid-2',
          canonical_task_id: 'c-uuid-2',
          alias_text: 'Authentication Module',
          alias_text_normalized: 'authentication module',
          embedding: Array(384).fill(-0.1),
          confidence_score: 1.0,
          source: 'user_confirmed',
          created_at: new Date().toISOString()
        }
      ],
      task_dependencies: [],
      dependency_patterns: [
        {
          id: 'p-uuid-1',
          task_id: 'c-uuid-2', // Authentication Module depends on Database Setup
          depends_on_task_id: 'c-uuid-1',
          frequency_count: 5,
          confidence: 0.8333,
          last_updated: new Date().toISOString()
        },
        {
          id: 'p-uuid-2',
          task_id: 'c-uuid-1',
          depends_on_task_id: 'c-uuid-2',
          frequency_count: 1, // Below sample size 3 threshold
          confidence: 0.2000,
          last_updated: new Date().toISOString()
        }
      ],
      resolution_logs: []
    };
  });

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 1: TEXT NORMALIZATION & TRIGRAM SIMILARITY
  // ─────────────────────────────────────────────────────────────────────────
  describe('Layer 1: Normalization & Trigram Similarity', () => {
    test('normalizes task input by stripping punctuation, lowercasing, and removing stopwords', () => {
      const input = 'Developing working on the Database Setup!';
      const normalized = normalizeText(input);
      expect(normalized).toBe('database setup');
    });

    test('computes exact trigram similarity = 1.0 for identical normalized strings', () => {
      const sim = computeTrigramSimilarity('database setup', 'database setup');
      expect(sim).toBe(1.0);
    });

    test('executes Layer 1 fuzzy match with similarity >= 0.85', async () => {
      const result = await normalize_and_fuzzy_match('developing database setup', mockDbContext, 0.85);
      expect(result).not.toBeNull();
      expect(result.matched).toBe(true);
      expect(result.source).toBe('fuzzy_match');
      expect(result.canonical_task_id).toBe('c-uuid-1');
      expect(result.similarity).toBeGreaterThanOrEqual(0.85);
    });

    test('returns null when fuzzy similarity is below threshold', async () => {
      const result = await normalize_and_fuzzy_match('Completely Random Unrelated Task Name', mockDbContext, 0.85);
      expect(result).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 2: LAYER 2 EMBEDDING SIMILARITY SEARCH
  // ─────────────────────────────────────────────────────────────────────────
  describe('Layer 2: Embedding Similarity Search', () => {
    test('computes vector cosine similarity accurately', () => {
      const v1 = [1, 0, 0];
      const v2 = [1, 0, 0];
      const v3 = [-1, 0, 0];
      expect(cosineSimilarity(v1, v2)).toBeCloseTo(1.0);
      expect(cosineSimilarity(v1, v3)).toBeCloseTo(-1.0);
    });

    test('high confidence embedding match (>= 0.80) auto-matches to canonical task', async () => {
      // Mock embedding output to closely match c-uuid-1 vector [0.1, 0.1, ...]
      const mockLLM = new MockLLMProvider();
      const resolution = await resolveTaskName('database setup', mockDbContext, { llmProvider: mockLLM });

      expect(resolution.resolved).toBe(true);
      expect(resolution.canonical_task_id).toBe('c-uuid-1');
      expect(resolution.pending_confirmation).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 3: LAYER 3 LLM FALLBACK & USER CONFIRMATION
  // ─────────────────────────────────────────────────────────────────────────
  describe('Layer 3: LLM Fallback & User Confirmation', () => {
    test('ambiguous score triggers LLM fallback and creates pending user confirmation alias', async () => {
      // Custom mock rule simulating ambiguous match resolving to c-uuid-1
      const mockLLM = new MockLLMProvider([
        {
          inputText: 'Set up relational schema',
          match: 'c-uuid-1',
          confidence: 'medium',
          reasoning: 'Relational schema setup is synonymous with Database Setup.'
        }
      ]);

      const resolution = await resolveTaskName('Set up relational schema', mockDbContext, { llmProvider: mockLLM });

      expect(resolution.resolved).toBe(true);
      expect(resolution.layer).toBe('llm_fallback');
      expect(resolution.canonical_task_id).toBe('c-uuid-1');
      expect(resolution.pending_confirmation).toBe(true);

      // Verify alias saved with source='llm_suggested'
      const savedAlias = mockDbContext.task_aliases.find(a => a.alias_text === 'Set up relational schema');
      expect(savedAlias).toBeDefined();
      expect(savedAlias.source).toBe('llm_suggested');
    });

    test('confirmAlias updates source to user_confirmed and sets confidence = 1.0', async () => {
      // Add a pending llm_suggested alias
      mockDbContext.task_aliases.push({
        id: 'a-pending-1',
        canonical_task_id: 'c-uuid-1',
        alias_text: 'DB Init',
        alias_text_normalized: 'db init',
        confidence_score: 0.7,
        source: 'llm_suggested'
      });

      const confirmed = await confirmAlias('DB Init', 'c-uuid-1', mockDbContext);
      expect(confirmed.success).toBe(true);

      const alias = mockDbContext.task_aliases.find(a => a.alias_text === 'DB Init');
      expect(alias.source).toBe('user_confirmed');
      expect(alias.confidence_score).toBe(1.0);
    });

    test('no-match scenario creates genuinely new canonical task', async () => {
      const mockLLM = new MockLLMProvider([
        {
          inputText: 'Executive Board Financial Audit',
          match: null,
          confidence: 'high',
          reasoning: 'Genuinely distinct task.'
        }
      ]);

      const resolution = await resolveTaskName('Executive Board Financial Audit', mockDbContext, { llmProvider: mockLLM });

      expect(resolution.resolved).toBe(true);
      expect(resolution.is_new_task).toBe(true);
      expect(resolution.layer).toBe('no_match');
      expect(resolution.canonical_name).toBe('Executive Board Financial Audit');

      // Verify canonical_tasks list updated
      const newCanonical = mockDbContext.canonical_tasks.find(c => c.canonical_name === 'Executive Board Financial Audit');
      expect(newCanonical).toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 4: DEPENDENCY SUGGESTION & PATTERN FREQUENCY
  // ─────────────────────────────────────────────────────────────────────────
  describe('Dependency Suggestion & Precomputed Patterns', () => {
    test('surfaces suggested dependencies above sample size threshold (>= 3)', async () => {
      const suggestions = await getSuggestedDependencies(['c-uuid-1', 'c-uuid-2'], mockDbContext, 3);
      
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0].task_id).toBe('c-uuid-2');
      expect(suggestions[0].depends_on_task_id).toBe('c-uuid-1');
      expect(suggestions[0].frequency_count).toBe(5);
    });

    test('filters out rare/idiosyncratic patterns below sample size threshold', async () => {
      const suggestions = await getSuggestedDependencies(['c-uuid-1', 'c-uuid-2'], mockDbContext, 10);
      expect(suggestions).toHaveLength(0);
    });

    test('confirmDependencies records user dependency and increments pattern frequency', async () => {
      const edges = [
        { task_id: 'c-uuid-2', depends_on_task_id: 'c-uuid-1', sequence_order: 1 }
      ];

      const res = await confirmDependencies(1, edges, mockDbContext);
      expect(res.success).toBe(true);
      expect(res.count).toBe(1);

      // Verify pattern frequency count incremented from 5 to 6
      const pattern = mockDbContext.dependency_patterns.find(
        p => p.task_id === 'c-uuid-2' && p.depends_on_task_id === 'c-uuid-1'
      );
      expect(pattern.frequency_count).toBe(6);
    });
  });
});
