/**
 * Configuration for Task Dependency Recommendation System
 * All threshold values and stopword lists are configurable via environment variables.
 */

const dotenv = require('dotenv');
dotenv.config();

const parseEnvFloat = (envVar, defaultValue) => {
  const parsed = parseFloat(process.env[envVar]);
  return !isNaN(parsed) ? parsed : defaultValue;
};

const parseEnvInt = (envVar, defaultValue) => {
  const parsed = parseInt(process.env[envVar], 10);
  return !isNaN(parsed) ? parsed : defaultValue;
};

const DEFAULT_STOPWORDS = [
  'task',
  'the',
  'a',
  'an',
  'and',
  'or',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'by'
];

const DEFAULT_PHRASES = [
  'developing',
  'working on',
  'implementing',
  'building',
  'creating',
  'setting up'
];

const getStopwords = () => {
  if (process.env.STOPWORDS) {
    return process.env.STOPWORDS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  }
  return DEFAULT_STOPWORDS;
};

module.exports = {
  // Layer 1 Fuzzy match threshold (similarity >= 0.85)
  FUZZY_THRESHOLD: parseEnvFloat('FUZZY_THRESHOLD', 0.85),

  // Layer 2 Embedding similarity thresholds
  EMBEDDING_HIGH_THRESHOLD: parseEnvFloat('EMBEDDING_HIGH_THRESHOLD', 0.80),
  EMBEDDING_LOW_THRESHOLD: parseEnvFloat('EMBEDDING_LOW_THRESHOLD', 0.55),

  // Minimum user observations required to present pattern suggestions
  MIN_PATTERN_SAMPLE_SIZE: parseEnvInt('MIN_PATTERN_SAMPLE_SIZE', 3),

  // Model name for sentence-transformers
  EMBEDDING_MODEL_NAME: process.env.EMBEDDING_MODEL_NAME || 'Xenova/all-MiniLM-L6-v2',

  // Configurable stopword list & action phrases
  STOPWORDS: getStopwords(),
  STOPWORD_PHRASES: DEFAULT_PHRASES
};
