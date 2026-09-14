import type { Env } from '../env';
import { HttpError } from '../http';

const ACTIVE_MODEL_KEY = 'active_ai_model';
const ACTIVE_MODEL_REVISION_KEY = 'active_ai_model_revision';
const ACTIVE_MODEL_REVISION = 'gemini-unified-v1';

export function availableAiModels(env: Env): string[] {
  const configured = env.AVAILABLE_AI_MODELS.split(',')
    .map((model) => model.trim())
    .filter(Boolean);
  const fallback = env.DEFAULT_AI_MODEL.trim();
  return [...new Set(fallback ? [fallback, ...configured] : configured)];
}

export async function activeAiModel(env: Env): Promise<string> {
  const available = availableAiModels(env);
  if (available.length === 0) throw new HttpError(500, 'No AI models are configured');

  const rows = await env.DB.prepare('SELECT key, value FROM config WHERE key IN (?1, ?2)')
    .bind(ACTIVE_MODEL_KEY, ACTIVE_MODEL_REVISION_KEY)
    .all<{ key: string; value: string }>();
  const config = new Map(rows.results.map((row) => [row.key, row.value]));
  const selected = config.get(ACTIVE_MODEL_KEY);
  return config.get(ACTIVE_MODEL_REVISION_KEY) === ACTIVE_MODEL_REVISION
      && selected
      && available.includes(selected)
    ? selected
    : available[0]!;
}

export async function setActiveAiModel(env: Env, model: string): Promise<void> {
  if (!availableAiModels(env).includes(model)) {
    throw new HttpError(400, 'Model is not in AVAILABLE_AI_MODELS');
  }
  const upsert = env.DB.prepare(
    `INSERT INTO config (key, value, updated_at) VALUES (?1, ?2, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  );
  await env.DB.batch([
    upsert.bind(ACTIVE_MODEL_KEY, model),
    upsert.bind(ACTIVE_MODEL_REVISION_KEY, ACTIVE_MODEL_REVISION),
  ]);
}
