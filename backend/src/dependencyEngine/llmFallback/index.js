/**
 * LLM Fallback Provider Factory
 * Instantiates GeminiLLMProvider if GEMINI_API_KEY is present, else defaults to MockLLMProvider.
 */

const GeminiLLMProvider = require('./GeminiLLMProvider');
const MockLLMProvider = require('./MockLLMProvider');

let activeProvider = null;

function getLLMProvider(overrideProvider = null) {
  if (overrideProvider) {
    return overrideProvider;
  }
  if (!activeProvider) {
    if (process.env.GEMINI_API_KEY) {
      console.log('[LLMProvider] Using GeminiLLMProvider');
      activeProvider = new GeminiLLMProvider();
    } else {
      console.log('[LLMProvider] GEMINI_API_KEY not found; using MockLLMProvider');
      activeProvider = new MockLLMProvider();
    }
  }
  return activeProvider;
}

function setLLMProvider(provider) {
  activeProvider = provider;
}

module.exports = {
  getLLMProvider,
  setLLMProvider,
  GeminiLLMProvider,
  MockLLMProvider
};
