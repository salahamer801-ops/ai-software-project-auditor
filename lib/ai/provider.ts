/**
 * Single AI provider abstraction (§7, §29). Nothing in the product is bound to one
 * vendor: any OpenAI-compatible endpoint works, and without a key the whole platform
 * still runs with rules-engine explanations.
 */

export interface AiCallResult<T> {
  data: T;
  model: string;
  usage: { promptTokens: number | null; completionTokens: number | null };
}

export function aiModel(): string {
  return (process.env.AI_MODEL ?? "gpt-4o-mini").trim();
}

export function aiBaseUrl(): string {
  return (process.env.AI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
}

export function aiConfigured(): boolean {
  return Boolean((process.env.AI_API_KEY ?? process.env.OPENAI_API_KEY ?? "").trim());
}

export class AiError extends Error {}

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new AiError("ai_response_not_json");
  }
}

export async function callAiJson<T>(input: {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
}): Promise<AiCallResult<T>> {
  const key = (process.env.AI_API_KEY ?? process.env.OPENAI_API_KEY ?? "").trim();
  if (!key) throw new AiError("ai_not_configured");

  const response = await fetch(`${aiBaseUrl()}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: aiModel(),
      temperature: input.temperature ?? 0.1,
      max_tokens: input.maxTokens ?? 900,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
    }),
    signal: AbortSignal.timeout(45_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new AiError(`ai_http_${response.status}: ${body.slice(0, 200)}`);
  }

  const payload = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
    model?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const content = payload.choices?.[0]?.message?.content ?? "";
  if (!content) throw new AiError("ai_empty_response");

  return {
    data: extractJson(content) as T,
    model: payload.model ?? aiModel(),
    usage: {
      promptTokens: payload.usage?.prompt_tokens ?? null,
      completionTokens: payload.usage?.completion_tokens ?? null,
    },
  };
}
