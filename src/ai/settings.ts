import { activeAiModel, availableAiModels, setActiveAiModel } from './models';
import type { Env } from '../env';
import { HttpError, jsonResponse, normalizeText } from '../http';

export async function handleAiModelsGet(env: Env): Promise<Response> {
  return jsonResponse({
    ok: true,
    provider: env.AI_PROVIDER || 'cloudflare_ai_gateway',
    models: availableAiModels(env),
    activeModel: await activeAiModel(env),
    fallbackModel: env.DEFAULT_AI_MODEL,
  });
}

export async function handleAiModelPost(body: Record<string, unknown>, env: Env): Promise<Response> {
  const model = normalizeText(body.model, 200);
  if (!model) throw new HttpError(400, 'model is required');
  await setActiveAiModel(env, model);
  return jsonResponse({ ok: true, activeModel: model });
}
