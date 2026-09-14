import type { z } from 'zod';
import type { Env } from '../env';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class AiError extends Error {
  stage: string;
  constructor(stage: string, message: string) {
    super(message);
    this.stage = stage;
  }
}

interface ChatCompletionsEnvelope {
  choices?: Array<{ message?: { content?: unknown } }>;
  result?: ChatCompletionsEnvelope;
  state?: string;
  error?: { message?: string };
  errors?: Array<{ code?: number; message?: string }>;
}

function completionContent(envelope: ChatCompletionsEnvelope): unknown {
  return envelope.choices?.[0]?.message?.content
    ?? envelope.result?.choices?.[0]?.message?.content;
}

async function callModel(
  env: Env,
  model: string,
  messages: ChatMessage[],
  jsonSchema: unknown,
  maxTokens: number,
  useGateway: boolean
): Promise<unknown> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/v1/chat/completions`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.CF_AI_TOKEN}`,
    'Content-Type': 'application/json',
  };
  // A named gateway keeps model switching, logs, token usage, and cost analytics
  // on the same Cloudflare AI Gateway path.
  if (useGateway && env.AI_GATEWAY_ID) headers['cf-aig-gateway-id'] = env.AI_GATEWAY_ID;

  const completionBudget = model.startsWith('google/')
    ? Math.max(maxTokens, 4096)
    : maxTokens;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages,
      // Gemini's completion budget includes hidden reasoning tokens. A 1,200
      // token cap can therefore truncate a short JSON email after only a few
      // visible words. Keep enough headroom for reasoning plus the JSON body.
      max_completion_tokens: completionBudget,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'outreach_studio_output', strict: true, schema: jsonSchema },
      },
    }),
  });

  const envelope = (await res.json().catch(() => null)) as ChatCompletionsEnvelope | null;
  if (!res.ok || !envelope) {
    const detail = envelope?.error?.message
      || envelope?.errors?.map((e) => e.message).join('; ')
      || `HTTP ${res.status}`;
    throw new AiError('call', `AI Gateway request failed: ${detail}`);
  }
  const content = completionContent(envelope);
  if (content === undefined) throw new AiError('call', 'AI Gateway returned no completion content');
  return content;
}

function parseMaybeJson(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return value;
  const cleaned = value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    return undefined;
  }
}

/**
 * Run a model expecting structured JSON. Validates with zod; on invalid output
 * retries once with a corrective nudge, then throws AiError.
 */
export async function runJson<T>(
  env: Env,
  model: string,
  messages: ChatMessage[],
  jsonSchema: unknown,
  schema: z.ZodType<T>,
  opts?: { maxTokens?: number }
): Promise<T> {
  const maxTokens = opts?.maxTokens ?? 900;
  if (!env.CF_AI_TOKEN || env.CF_AI_TOKEN === 'replace-me') {
    throw new AiError('config', 'CF_AI_TOKEN is not configured');
  }

  let lastIssue = '';
  let attemptMessages = messages;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await callModel(env, model, attemptMessages, jsonSchema, maxTokens, true);
    const parsed = parseMaybeJson(raw);
    const check = schema.safeParse(parsed);
    if (check.success) return check.data;
    lastIssue = check.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    attemptMessages = [
      ...messages,
      {
        role: 'user',
        content:
          'Your previous output was invalid (' +
          lastIssue.slice(0, 300) +
          '). Return ONLY a valid JSON object matching the required schema. No prose, no code fences.',
      },
    ];
  }
  throw new AiError('validate', `Model output failed validation: ${lastIssue.slice(0, 300)}`);
}
