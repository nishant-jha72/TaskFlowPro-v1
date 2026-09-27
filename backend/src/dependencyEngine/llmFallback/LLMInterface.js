/**
 * Abstract Base Interface for LLM Fallback Providers
 * Enables swappable LLM models (Gemini, OpenAI, Anthropic, Mock) without modifying Layers 1 or 2.
 */

class LLMInterface {
  /**
   * Resolves an input task name against candidates using LLM disambiguation.
   * @param {string} inputText - User entered task name
   * @param {Array<{canonical_task_id: string, canonical_name: string, similarity: number}>} candidates - Top embedding candidates
   * @returns {Promise<{match: string|null, confidence: "high"|"medium"|"low", reasoning: string}>}
   */
  async resolveTask(inputText, candidates) {
    throw new Error('LLMInterface.resolveTask() must be implemented by subclass');
  }
}

module.exports = LLMInterface;
