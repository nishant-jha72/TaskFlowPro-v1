/**
 * Gemini LLM Provider Implementation
 * Uses Google Generative AI with strict JSON output formatting.
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');
const LLMInterface = require('./LLMInterface');

class GeminiLLMProvider extends LLMInterface {
  constructor(apiKey = process.env.GEMINI_API_KEY) {
    super();
    this.apiKey = apiKey;
    if (this.apiKey) {
      const genAI = new GoogleGenerativeAI(this.apiKey);
      this.model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    }
  }

  async resolveTask(inputText, candidates = []) {
    if (!this.model) {
      throw new Error('Gemini API key is not configured');
    }

    const candidateListStr = candidates.length > 0
      ? candidates.map((c, i) => `${i + 1}. ID: "${c.canonical_task_id}", Name: "${c.canonical_name}" (Similarity score: ${c.similarity})`).join('\n')
      : 'None (no close matches found)';

    const prompt = `
You are a task disambiguation classifier for a project management tool.
Your goal is to decide whether a new user-provided task name is a synonym/rephrase of an existing canonical task, or if it represents a genuinely new distinct task.

Input Task Name: "${inputText}"

Candidate Canonical Tasks:
${candidateListStr}

Instructions:
1. Carefully compare the input task name against the candidates.
2. If the input is a synonym, variation, abbreviation, or rephrase of one candidate, match it to that candidate's ID.
3. If the input is distinct from all candidates or there are no candidates, return "match": null.
4. You MUST respond with ONLY a raw valid JSON object (no markdown, no code blocks) matching this exact format:
{
  "match": "canonical_task_id or null",
  "confidence": "high" | "medium" | "low",
  "reasoning": "One concise sentence explaining the decision."
}
`;

    try {
      const result = await this.model.generateContent(prompt);
      const text = result.response.text().trim();
      
      // Clean markdown formatting if returned
      const cleanJsonStr = text.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
      const parsed = JSON.parse(cleanJsonStr);

      return {
        match: parsed.match && parsed.match !== 'null' ? parsed.match : null,
        confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'low',
        reasoning: parsed.reasoning || 'Disambiguated via LLM fallback.'
      };
    } catch (err) {
      console.error('[GeminiLLMProvider] LLM resolution failed:', err.message);
      return {
        match: null,
        confidence: 'low',
        reasoning: `LLM execution error: ${err.message}`
      };
    }
  }
}

module.exports = GeminiLLMProvider;
