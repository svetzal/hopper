export interface LlmCompletionRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  response_format?: unknown;
}

export interface LlmCompletionResponse {
  choices: Array<{ message: { content: string } }>;
}

export interface LlmGateway {
  chatCompletion(request: LlmCompletionRequest): Promise<LlmCompletionResponse>;
}

export function createLlmGateway(apiKey: string): LlmGateway {
  return {
    async chatCompletion(request: LlmCompletionRequest): Promise<LlmCompletionResponse> {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status}`);
      }

      return (await response.json()) as LlmCompletionResponse;
    },
  };
}
