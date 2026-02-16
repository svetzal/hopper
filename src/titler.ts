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

export function createTitleGenerator(): TitleGenerator {
  const apiKey = process.env.OPENAI_API_KEY ?? "";

  return {
    async generateTitle(description: string): Promise<string> {
      if (!apiKey) {
        return description.slice(0, FALLBACK_TITLE_LENGTH).trim();
      }

      try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: "gpt-4.1-nano",
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: description },
            ],
            response_format: {
              type: "json_schema",
              json_schema: { name: "title_response", strict: true, schema: TITLE_SCHEMA },
            },
          }),
        });

        if (!response.ok) {
          throw new Error(`OpenAI API error: ${response.status}`);
        }

        const data = (await response.json()) as {
          choices: Array<{ message: { content: string } }>;
        };
        const content = data.choices[0]?.message?.content;
        if (content) {
          const parsed = JSON.parse(content) as { title: string };
          if (parsed.title) {
            return parsed.title;
          }
        }
      } catch {
        // Fall through to fallback
      }

      return description.slice(0, FALLBACK_TITLE_LENGTH).trim();
    },
  };
}
