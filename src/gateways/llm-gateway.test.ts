import { afterEach, describe, expect, test } from "bun:test";
import { createLlmGateway } from "./llm-gateway.ts";

describe("LlmGateway", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("sends POST to OpenAI endpoint with correct auth header and returns parsed response", async () => {
    const mockResponse = { choices: [{ message: { content: "Hello!" } }] };
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;

    globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
      capturedUrl = input.toString();
      capturedInit = init;
      return new Response(JSON.stringify(mockResponse), { status: 200 });
    }) as unknown as typeof fetch;

    const gateway = createLlmGateway("test-api-key");
    const result = await gateway.chatCompletion({
      model: "gpt-4.1-nano",
      messages: [{ role: "user", content: "Hello" }],
    });

    expect(capturedUrl).toBe("https://api.openai.com/v1/chat/completions");
    expect(capturedInit).toBeDefined();
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers?.Authorization).toBe("Bearer test-api-key");
    expect(result).toEqual(mockResponse);
  });

  test("sends the request body as JSON with correct Content-Type", async () => {
    let capturedBody: unknown;

    globalThis.fetch = (async (_input: Request | string | URL, init?: RequestInit) => {
      expect(init).toBeDefined();
      const bodyStr = init?.body;
      expect(typeof bodyStr).toBe("string");
      capturedBody = JSON.parse(bodyStr as string);
      return new Response(JSON.stringify({ choices: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const gateway = createLlmGateway("key");
    const request = { model: "gpt-4.1-nano", messages: [{ role: "user", content: "test" }] };
    await gateway.chatCompletion(request);

    expect(capturedBody).toEqual(request);
  });

  test("returns empty choices when fetch returns a non-ok response", async () => {
    globalThis.fetch = (async () =>
      new Response("Unauthorized", { status: 401 })) as unknown as typeof fetch;

    const gateway = createLlmGateway("bad-key");
    expect(await gateway.chatCompletion({ model: "gpt-4.1-nano", messages: [] })).toEqual({
      choices: [],
    });
  });

  test("returns empty choices when response body is not a JSON object with choices array", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "overloaded" } }), {
        status: 200,
      })) as unknown as typeof fetch;

    const gateway = createLlmGateway("key");
    expect(await gateway.chatCompletion({ model: "gpt-4.1-nano", messages: [] })).toEqual({
      choices: [],
    });
  });

  test("returns empty choices when response body is not valid JSON", async () => {
    globalThis.fetch = (async () =>
      new Response("not json at all", { status: 200 })) as unknown as typeof fetch;

    const gateway = createLlmGateway("key");
    expect(await gateway.chatCompletion({ model: "gpt-4.1-nano", messages: [] })).toEqual({
      choices: [],
    });
  });
});
