/**
 * Layer 1: Normalization + Fuzzy Matching Module
 * Normalizes input string and performs pg_trgm similarity or rapidfuzz/trigram matching.
 */

const { FUZZY_THRESHOLD, STOPWORDS, STOPWORD_PHRASES } = require('./config');

/**
 * Normalizes input text: lowercases, strips phrases & punctuation, and removes stopwords.
 * @param {string} text 
 * @param {string[]} stopwords 
 * @returns {string} Normalized string
 */
function normalizeText(text, stopwords = STOPWORDS) {
  if (!text || typeof text !== 'string') return '';
  
  let cleaned = text.toLowerCase();

  // 1. Strip multi-word stopword phrases (e.g. "working on", "developing")
  const phrases = STOPWORD_PHRASES || ['developing', 'working on', 'implementing', 'building', 'creating', 'setting up'];
  for (const phrase of phrases) {
    const reg = new RegExp(`\\b${phrase.toLowerCase()}\\b`, 'g');
    cleaned = cleaned.replace(reg, ' ');
  }

  // 2. Strip punctuation & normalize spaces
  cleaned = cleaned
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return '';

  // 3. Remove single-word stopwords
  const stopSet = new Set((stopwords || []).map((s) => s.toLowerCase()));
  const words = cleaned.split(' ').filter((w) => w && !stopSet.has(w));

  if (words.length === 0) {
    return cleaned;
  }

  return words.join(' ');
}

/**
 * Computes Trigram similarity between two strings (compatible with PostgreSQL pg_trgm similarity()).
 * @param {string} str1 
 * @param {string} str2 
 * @returns {number} Score between 0.0 and 1.0
 */
function computeTrigramSimilarity(str1, str2) {
  if (!str1 || !str2) return 0;
  if (str1 === str2) return 1.0;

  const getTrigrams = (s) => {
    const padded = `  ${s} `;
    const trigrams = new Set();
    for (let i = 0; i < padded.length - 2; i++) {
      trigrams.add(padded.substring(i, i + 3));
    }
    return trigrams;
  };

  const set1 = getTrigrams(str1);
  const set2 = getTrigrams(str2);

  let intersectionCount = 0;
  for (const tri of set1) {
    if (set2.has(tri)) {
      intersectionCount++;
    }
  }

  const unionSize = set1.size + set2.size - intersectionCount;
  if (unionSize === 0) return 0;
  return intersectionCount / unionSize;
}

/**
 * Executes Layer 1 fuzzy matching on input text.
 * @param {string} inputText - Raw task title from user
 * @param {Object} dbContext - Database interface or in-memory store
 * @param {number} [customThreshold] - Optional override for threshold
 * @returns {Promise<Object|null>} MatchResult or null if below threshold
 */
async function normalize_and_fuzzy_match(inputText, dbContext, customThreshold = FUZZY_THRESHOLD) {
  const normalizedInput = normalizeText(inputText);
  if (!normalizedInput) return null;

  // 1. Check PostgreSQL database using pg_trgm if dbContext has query capability
  if (dbContext && typeof dbContext.query === 'function') {
    try {
      const sql = `
        SELECT 
          ta.canonical_task_id,
          ta.alias_text,
          ta.alias_text_normalized,
          ct.canonical_name,
          similarity(ta.alias_text_normalized, $1) AS similarity_score
        FROM task_aliases ta
        JOIN canonical_tasks ct ON ta.canonical_task_id = ct.id
        WHERE similarity(ta.alias_text_normalized, $1) >= $2
        ORDER BY similarity_score DESC
        LIMIT 1;
      `;
      const res = await dbContext.query(sql, [normalizedInput, customThreshold]);
      if (res && res.rows && res.rows.length > 0) {
        const row = res.rows[0];
        return {
          matched: true,
          layer: 'fuzzy_match',
          source: 'fuzzy_match',
          canonical_task_id: row.canonical_task_id,
          canonical_name: row.canonical_name,
          alias_text: row.alias_text,
          similarity: parseFloat(row.similarity_score),
          normalizedInput
        };
      }
    } catch (err) {
      console.warn('[Layer1Fuzzy] DB query fallback:', err.message);
    }
  }

  // 2. In-memory / Mock DB fallback for testing and offline execution
  if (dbContext && Array.isArray(dbContext.task_aliases)) {
    let bestMatch = null;
    let highestScore = 0;

    for (const alias of dbContext.task_aliases) {
      const score = computeTrigramSimilarity(normalizedInput, alias.alias_text_normalized);
      if (score >= customThreshold && score > highestScore) {
        highestScore = score;
        const canonical = (dbContext.canonical_tasks || []).find((c) => c.id === alias.canonical_task_id);
        bestMatch = {
          matched: true,
          layer: 'fuzzy_match',
          source: 'fuzzy_match',
          canonical_task_id: alias.canonical_task_id,
          canonical_name: canonical ? canonical.canonical_name : alias.alias_text,
          alias_text: alias.alias_text,
          similarity: parseFloat(highestScore.toFixed(4)),
          normalizedInput
        };
      }
    }

    if (bestMatch) {
      return bestMatch;
    }
  }

  return null;
}

module.exports = {
  normalizeText,
  computeTrigramSimilarity,
  normalize_and_fuzzy_match
};
