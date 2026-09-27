/**
 * Mock LLM Provider Implementation
 * Deterministic fallback provider used for unit testing and offline development.
 */

const LLMInterface = require('./LLMInterface');

class MockLLMProvider extends LLMInterface {
  constructor(customRules = []) {
    super();
    this.customRules = customRules;
  }

  async resolveTask(inputText, candidates = []) {
    // Check if custom override rule exists
    const rule = this.customRules.find(
      (r) => r.inputText.toLowerCase() === inputText.toLowerCase()
    );
    if (rule) {
      return {
        match: rule.match,
        confidence: rule.confidence || 'high',
        reasoning: rule.reasoning || 'Matched via mock rule.'
      };
    }

    // Default mock behavior: if candidates exist and top similarity >= 0.60, match top candidate
    if (candidates && candidates.length > 0 && candidates[0].similarity >= 0.60) {
      return {
        match: candidates[0].canonical_task_id,
        confidence: 'medium',
        reasoning: `Mock LLM disambiguated '${inputText}' to '${candidates[0].canonical_name}'.`
      };
    }

    // Otherwise, treat as new task
    return {
      match: null,
      confidence: 'high',
      reasoning: `Mock LLM confirmed '${inputText}' is a distinct new task.`
    };
  }
}

module.exports = MockLLMProvider;
