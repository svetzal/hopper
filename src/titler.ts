import type { LlmGateway } from "./gateways/llm-gateway.ts";

const SYSTEM_PROMPT =
  "Generate a concise, action-oriented title (max 8 words) for this work item. Respond with only the title.";

const TITLE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "A concise, action-oriented title (max 8 words)" },
  },
  required: ["title"],
  additionalProperties: false,
};

export interface TitleGenerator {
  generateTitle(description: string): Promise<string>;
}

const FALLBACK_TITLE_LENGTH = 60;

export function createTitleGenerator(llm?: LlmGateway): TitleGenerator {
  return {
    async generateTitle(description: string): Promise<string> {
      if (!llm) {
        return description.slice(0, FALLBACK_TITLE_LENGTH).trim();
      }

      try {
        const data = await llm.chatCompletion({
          model: "gpt-4.1-nano",
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: description },
          ],
          response_format: {
            type: "json_schema",
            json_schema: { name: "title_response", strict: true, schema: TITLE_SCHEMA },
          },
        });

        const content = data.choices[0]?.message?.content;
        if (content) {
          const parsed = JSON.parse(content) as { title: string };
          if (parsed.title) {
            return parsed.title;
          }
        }
      } catch {
        // fallback below
      }

      return description.slice(0, FALLBACK_TITLE_LENGTH).trim();
    },
  };
}
