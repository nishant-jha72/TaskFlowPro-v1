/**
 * Layer 2: Embedding Similarity Search Module
 * Generates 384-dim vector using sentence-transformers/all-MiniLM-L6-v2 and queries pgvector.
 */

const { EMBEDDING_HIGH_THRESHOLD, EMBEDDING_LOW_THRESHOLD } = require('./config');
const { embedText } = require('./embeddingService');

/**
 * Computes cosine similarity between two normalized vectors.
 * @param {number[]} vecA 
 * @param {number[]} vecB 
 * @returns {number} Cosine similarity (-1 to 1)
 */
function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Converts JS array of numbers to Postgres pgvector string format "[0.1, 0.2, ...]"
 * @param {number[]} vector 
 * @returns {string}
 */
function vectorToPgString(vector) {
  return `[${vector.join(',')}]`;
}

/**
 * Executes Layer 2 embedding search on input text.
 * @param {string} inputText - Input text to embed and search
 * @param {Object} dbContext - Database client or in-memory store
 * @param {Object} [options] - Custom thresholds
 * @returns {Promise<Object>} MatchResult containing status, candidate tasks, and similarity score
 */
async function embedding_match(inputText, dbContext, options = {}) {
  const highThreshold = options.highThreshold || EMBEDDING_HIGH_THRESHOLD;
  const lowThreshold = options.lowThreshold || EMBEDDING_LOW_THRESHOLD;

  // 1. Generate 384d embedding
  const embedding = await embedText(inputText);
  const pgVectorStr = vectorToPgString(embedding);

  let candidates = [];

  // 2. Query PostgreSQL pgvector if dbContext has query interface
  if (dbContext && typeof dbContext.query === 'function') {
    try {
      const sql = `
        SELECT 
          id AS canonical_task_id,
          canonical_name,
          1 - (embedding <=> $1::vector) AS similarity
        FROM canonical_tasks
        WHERE embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector ASC
        LIMIT 5;
      `;
      const res = await dbContext.query(sql, [pgVectorStr]);
      if (res && res.rows) {
        candidates = res.rows.map((row) => ({
          canonical_task_id: row.canonical_task_id,
          canonical_name: row.canonical_name,
          similarity: parseFloat(parseFloat(row.similarity).toFixed(4))
        }));
      }
    } catch (err) {
      console.warn('[Layer2Embedding] DB vector query fallback:', err.message);
    }
  }

  // 3. Fallback to in-memory store if DB query returned no candidates or wasn't connected
  if (candidates.length === 0 && dbContext && Array.isArray(dbContext.canonical_tasks)) {
    candidates = dbContext.canonical_tasks
      .filter((task) => task.embedding && task.embedding.length > 0)
      .map((task) => {
        const sim = cosineSimilarity(embedding, task.embedding);
        return {
          canonical_task_id: task.id,
          canonical_name: task.canonical_name,
          similarity: parseFloat(sim.toFixed(4))
        };
      })
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 5);
  }

  const topCandidate = candidates.length > 0 ? candidates[0] : null;
  const topSimilarity = topCandidate ? topCandidate.similarity : 0;

  // 4. Determine classification band
  if (topCandidate && topSimilarity >= highThreshold) {
    return {
      matched: true,
      status: 'HIGH_CONFIDENCE',
      layer: 'embedding_match',
      source: 'embedding_match',
      canonical_task_id: topCandidate.canonical_task_id,
      canonical_name: topCandidate.canonical_name,
      similarity: topSimilarity,
      embedding,
      candidates
    };
  }

  if (topCandidate && topSimilarity >= lowThreshold) {
    return {
      matched: false,
      status: 'AMBIGUOUS',
      layer: 'embedding_match',
      similarity: topSimilarity,
      embedding,
      candidates: candidates.slice(0, 3)
    };
  }

  return {
    matched: false,
    status: 'NO_MATCH',
    layer: 'embedding_match',
    similarity: topSimilarity,
    embedding,
    candidates: []
  };
}

module.exports = {
  cosineSimilarity,
  vectorToPgString,
  embedding_match
};
