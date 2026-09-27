/**
 * Composite Resolution Pipeline Module
 * Orchestrates Layer 1 (Fuzzy) -> Layer 2 (Embedding) -> Layer 3 (LLM Fallback)
 * Logs all decisions to resolution_logs and handles database persistence.
 */

const { crypto } = require('crypto');
const v4 = () => (require('crypto').randomUUID ? require('crypto').randomUUID() : Math.random().toString(36).substring(2));

const { normalize_and_fuzzy_match, normalizeText } = require('./layer1Fuzzy');
const { embedding_match, vectorToPgString } = require('./layer2Embedding');
const { getLLMProvider } = require('./llmFallback');

/**
 * Logs a resolution decision to resolution_logs table or memory store.
 */
async function logResolution(dbContext, { inputText, canonicalTaskId, layer, similarityScore, reasoning, metadata = {} }) {
  if (dbContext && typeof dbContext.query === 'function') {
    try {
      const sql = `
        INSERT INTO resolution_logs 
          (input_text, resolved_canonical_task_id, layer, similarity_score, reasoning, metadata)
        VALUES ($1, $2, $3, $4, $5, $6);
      `;
      await dbContext.query(sql, [
        inputText,
        canonicalTaskId || null,
        layer,
        similarityScore != null ? similarityScore : null,
        reasoning || '',
        JSON.stringify(metadata)
      ]);
    } catch (err) {
      console.warn('[ResolutionPipeline] Failed to insert resolution log into DB:', err.message);
    }
  }

  if (dbContext && Array.isArray(dbContext.resolution_logs)) {
    dbContext.resolution_logs.push({
      id: v4(),
      input_text: inputText,
      resolved_canonical_task_id: canonicalTaskId || null,
      layer,
      similarity_score: similarityScore,
      reasoning,
      metadata,
      created_at: new Date().toISOString()
    });
  }
}

/**
 * Inserts or updates an alias in task_aliases table or memory store.
 */
async function saveAlias(dbContext, { canonicalTaskId, aliasText, embedding, confidenceScore, source }) {
  const normalizedText = normalizeText(aliasText);
  const pgVectorStr = embedding ? vectorToPgString(embedding) : null;

  if (dbContext && typeof dbContext.query === 'function') {
    try {
      const sql = `
        INSERT INTO task_aliases 
          (canonical_task_id, alias_text, alias_text_normalized, embedding, confidence_score, source)
        VALUES ($1, $2, $3, $4::vector, $5, $6)
        ON CONFLICT DO NOTHING;
      `;
      await dbContext.query(sql, [
        canonicalTaskId,
        aliasText,
        normalizedText,
        pgVectorStr,
        confidenceScore,
        source
      ]);
    } catch (err) {
      console.warn('[ResolutionPipeline] Failed to save task alias in DB:', err.message);
    }
  }

  if (dbContext && Array.isArray(dbContext.task_aliases)) {
    const existing = dbContext.task_aliases.find(
      (a) => a.canonical_task_id === canonicalTaskId && a.alias_text_normalized === normalizedText
    );
    if (existing) {
      existing.source = source;
      existing.confidence_score = confidenceScore;
    } else {
      dbContext.task_aliases.push({
        id: v4(),
        canonical_task_id: canonicalTaskId,
        alias_text: aliasText,
        alias_text_normalized: normalizedText,
        embedding: embedding || null,
        confidence_score: confidenceScore,
        source,
        created_at: new Date().toISOString()
      });
    }
  }
}

/**
 * Resolves a single user-entered task name through the 3-layer cascade.
 * @param {string} inputText - User task title
 * @param {Object} dbContext - Database client or memory store
 * @param {Object} [options] - Custom options (e.g. llmProvider)
 * @returns {Promise<Object>} ResolutionResult
 */
async function resolveTaskName(inputText, dbContext, options = {}) {
  const llmProvider = options.llmProvider || getLLMProvider();

  // ─────────────────────────────────────────────────────────────────────────
  // LAYER 1: FUZZY / EXACT MATCHING
  // ─────────────────────────────────────────────────────────────────────────
  const fuzzyMatch = await normalize_and_fuzzy_match(inputText, dbContext);
  if (fuzzyMatch && fuzzyMatch.matched) {
    await logResolution(dbContext, {
      inputText,
      canonicalTaskId: fuzzyMatch.canonical_task_id,
      layer: 'fuzzy_match',
      similarityScore: fuzzyMatch.similarity,
      reasoning: `Resolved via Layer 1 fuzzy match against alias '${fuzzyMatch.alias_text}'`
    });

    return {
      resolved: true,
      layer: 'fuzzy_match',
      canonical_task_id: fuzzyMatch.canonical_task_id,
      canonical_name: fuzzyMatch.canonical_name,
      confidence_score: fuzzyMatch.similarity,
      pending_confirmation: false,
      reasoning: `Fuzzy matched with similarity ${fuzzyMatch.similarity}`
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LAYER 2: EMBEDDING SIMILARITY SEARCH
  // ─────────────────────────────────────────────────────────────────────────
  const embResult = await embedding_match(inputText, dbContext);

  if (embResult.matched && embResult.status === 'HIGH_CONFIDENCE') {
    // High-confidence embedding match: auto-commit alias for future fuzzy matches
    await saveAlias(dbContext, {
      canonicalTaskId: embResult.canonical_task_id,
      aliasText: inputText,
      embedding: embResult.embedding,
      confidenceScore: embResult.similarity,
      source: 'embedding_match'
    });

    await logResolution(dbContext, {
      inputText,
      canonicalTaskId: embResult.canonical_task_id,
      layer: 'embedding_match',
      similarityScore: embResult.similarity,
      reasoning: `Resolved via Layer 2 high-confidence embedding match`
    });

    return {
      resolved: true,
      layer: 'embedding_match',
      canonical_task_id: embResult.canonical_task_id,
      canonical_name: embResult.canonical_name,
      confidence_score: embResult.similarity,
      pending_confirmation: false,
      reasoning: `Embedding matched with high confidence (${embResult.similarity})`
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LAYER 3: LLM FALLBACK (Ambiguous or No-Match)
  // ─────────────────────────────────────────────────────────────────────────
  const candidates = embResult.candidates || [];
  const llmRes = await llmProvider.resolveTask(inputText, candidates);

  if (llmRes.match && llmRes.confidence !== 'low') {
    // LLM found a valid match candidate
    let matchedCanonicalName = 'Unknown Task';

    // Find candidate canonical_name
    const matchedCandidate = candidates.find((c) => c.canonical_task_id === llmRes.match);
    if (matchedCandidate) {
      matchedCanonicalName = matchedCandidate.canonical_name;
    } else if (dbContext && Array.isArray(dbContext.canonical_tasks)) {
      const found = dbContext.canonical_tasks.find((c) => c.id === llmRes.match);
      if (found) matchedCanonicalName = found.canonical_name;
    }

    // Persist as llm_suggested alias pending user confirmation
    await saveAlias(dbContext, {
      canonicalTaskId: llmRes.match,
      aliasText: inputText,
      embedding: embResult.embedding,
      confidenceScore: 0.70,
      source: 'llm_suggested'
    });

    await logResolution(dbContext, {
      inputText,
      canonicalTaskId: llmRes.match,
      layer: 'llm_fallback',
      similarityScore: embResult.similarity,
      reasoning: llmRes.reasoning,
      metadata: { llm_confidence: llmRes.confidence }
    });

    return {
      resolved: true,
      layer: 'llm_fallback',
      canonical_task_id: llmRes.match,
      canonical_name: matchedCanonicalName,
      confidence_score: 0.70,
      pending_confirmation: true,
      reasoning: llmRes.reasoning
    };
  }

  // Genuinely new task (No match in Layers 1, 2, or 3)
  // Auto-create new canonical task entry
  const newCanonicalId = v4();
  const normalizedInput = normalizeText(inputText);

  if (dbContext && typeof dbContext.query === 'function') {
    try {
      const pgVectorStr = embResult.embedding ? vectorToPgString(embResult.embedding) : null;
      await dbContext.query(
        `INSERT INTO canonical_tasks (id, canonical_name, embedding) VALUES ($1, $2, $3::vector) ON CONFLICT DO NOTHING;`,
        [newCanonicalId, inputText, pgVectorStr]
      );
      await saveAlias(dbContext, {
        canonicalTaskId: newCanonicalId,
        aliasText: inputText,
        embedding: embResult.embedding,
        confidenceScore: 1.0,
        source: 'user_confirmed'
      });
    } catch (err) {
      console.warn('[ResolutionPipeline] Failed creating new canonical task in DB:', err.message);
    }
  }

  if (dbContext && Array.isArray(dbContext.canonical_tasks)) {
    dbContext.canonical_tasks.push({
      id: newCanonicalId,
      canonical_name: inputText,
      embedding: embResult.embedding || null,
      created_at: new Date().toISOString()
    });
    await saveAlias(dbContext, {
      canonicalTaskId: newCanonicalId,
      aliasText: inputText,
      embedding: embResult.embedding,
      confidenceScore: 1.0,
      source: 'user_confirmed'
    });
  }

  await logResolution(dbContext, {
    inputText,
    canonicalTaskId: newCanonicalId,
    layer: 'no_match',
    similarityScore: embResult.similarity,
    reasoning: `No existing match found; created new canonical task '${inputText}'`
  });

  return {
    resolved: true,
    is_new_task: true,
    layer: 'no_match',
    canonical_task_id: newCanonicalId,
    canonical_name: inputText,
    confidence_score: 1.0,
    pending_confirmation: false,
    reasoning: 'New distinct task created.'
  };
}

/**
 * Commits a user-confirmed alias mapping and updates trust weight.
 * @param {string} aliasText 
 * @param {string} canonicalTaskId 
 * @param {Object} dbContext 
 */
async function confirmAlias(aliasText, canonicalTaskId, dbContext) {
  const normalizedText = normalizeText(aliasText);

  if (dbContext && typeof dbContext.query === 'function') {
    try {
      const sql = `
        UPDATE task_aliases 
        SET source = 'user_confirmed', confidence_score = 1.0
        WHERE canonical_task_id = $1 AND (alias_text_normalized = $2 OR alias_text = $3);
      `;
      await dbContext.query(sql, [canonicalTaskId, normalizedText, aliasText]);
    } catch (err) {
      console.warn('[ResolutionPipeline] DB confirmAlias error:', err.message);
    }
  }

  if (dbContext && Array.isArray(dbContext.task_aliases)) {
    const existing = dbContext.task_aliases.find(
      (a) => a.canonical_task_id === canonicalTaskId && (a.alias_text_normalized === normalizedText || a.alias_text === aliasText)
    );
    if (existing) {
      existing.source = 'user_confirmed';
      existing.confidence_score = 1.0;
    }
  }

  return { success: true, alias_text: aliasText, canonical_task_id: canonicalTaskId, source: 'user_confirmed' };
}

module.exports = {
  resolveTaskName,
  confirmAlias,
  logResolution,
  saveAlias
};
