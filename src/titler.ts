import { OpenAIGateway, LlmBroker, Message, isOk } from "mojentic";

const TITLE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "A concise, action-oriented title (max 8 words)" },
  },
  required: ["title"],
};

const SYSTEM_PROMPT =
  "Generate a concise, action-oriented title (max 8 words) for this work item. Respond with only the title.";

export interface TitleGenerator {
  generateTitle(description: string): Promise<string>;
}

export function createTitleGenerator(): TitleGenerator {
  const gateway = new OpenAIGateway();
  const broker = new LlmBroker("gpt-4.1-nano", gateway);

  return {
    async generateTitle(description: string): Promise<string> {
      try {
        const result = await broker.generateObject<{ title: string }>(
          [Message.system(SYSTEM_PROMPT), Message.user(description)],
          TITLE_SCHEMA,
        );

        if (isOk(result) && result.value.title) {
          return result.value.title;
        }
      } catch {
        // Fall through to fallback
      }

      return description.slice(0, 60).trim();
    },
  };
}
