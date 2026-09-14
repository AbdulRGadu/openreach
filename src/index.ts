import { AiError } from './ai/client';
import { handleAiModelPost, handleAiModelsGet } from './ai/settings';
import { handleOutreachSettingsGet, handleOutreachSettingsPost } from './services/outreachSettings';
import { clearDemo, getWorkspaceProfile, handleOnboardingGet, handleWorkspaceProfileGet, handleWorkspaceProfilePut, seedDemo } from './services/workspaceProfile';
import { isAuthorized } from './auth';
import type { Env } from './env';
import { HttpError, jsonResponse, readJson } from './http';
import { getLead, handleLeadGet, handleLeadPatch, handleLeadsList, handleLeadsPost } from './leads';
import {
  handleMessageApprove,
  handleMessageCancel,
  handleMessageNeedsReview,
  handleMessagePatch,
  handleMessageReschedule,
  handleMessageRetry,
  handleMessagesQueue,
  handleMessageReject,
  handleMessagesList,
  handleSendNow,
} from './messages';
import { advancePipeline, draftLead, scoreLead } from './pipeline';
import {
  handleRepliesDebug,
  handleRepliesList,
  handleReplyIngest,
  handleReplyPost,
} from './replies';
import { runScheduled } from './schedule';
import { processSend } from './sending';
import { ensureDraftingSchema } from './schema';
import { handleOverview, handleStats } from './stats';
import {
  handleCampaignGet,
  handleCampaignClone,
  handleCampaignStopUnsent,
  handleCampaignLeadPost,
  handleCampaignPatch,
  handleCampaignPost,
  handleCampaignsList,
  handleSenderProfilePatch,
  handleSenderProfilePost,
  handleSenderProfilesList,
} from './services/campaigns';
import {
  handleSuppressionAdd,
  handleSuppressionDelete,
  handleSuppressionList,
  handleUnsubscribe,
} from './suppression';
import type { SendJob } from './types';

/** For POST endpoints where a JSON body is optional. */
async function readJsonOptional(request: Request): Promise<Record<string, unknown>> {
  try {
    const raw = (await request.json()) as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function numOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const segments = url.pathname.split('/').filter(Boolean);
  const resource = segments[1];
  const id = segments[2];
  const action = segments[3];
  const method = request.method.toUpperCase();

  if (resource === 'leads') {
    if (!id) {
      if (method === 'POST') return handleLeadsPost(await readJson(request), env);
      if (method === 'GET') return handleLeadsList(url, env);
    } else if (!action) {
      if (method === 'GET') return handleLeadGet(id, env);
      if (method === 'PATCH') return handleLeadPatch(id, await readJson(request), env);
    } else if (method === 'POST' && action === 'score') {
      const lead = await getLead(env, id);
      return jsonResponse({ ok: true, lead: await scoreLead(env, lead) });
    } else if (method === 'POST' && action === 'draft') {
      const body = await readJsonOptional(request);
      const lead = await getLead(env, id);
      const message = await draftLead(env, lead, { force: body.force === true });
      return jsonResponse({ ok: true, message });
    }
  }

  if (resource === 'pipeline' && id === 'advance' && !action && method === 'POST') {
    const body = await readJsonOptional(request);
    const result = await advancePipeline(env, numOrUndefined(body.scoreBatch), numOrUndefined(body.draftBatch));
    return jsonResponse({ ok: true, ...result });
  }

  if (resource === 'workspace-profile' && !id) {
    if (method === 'GET') return handleWorkspaceProfileGet(env);
    if (method === 'PUT') return handleWorkspaceProfilePut(await readJson(request), env);
  }
  if (resource === 'onboarding' && !id && method === 'GET') return handleOnboardingGet(env);
  if (resource === 'demo' && method === 'POST') {
    if (id === 'seed') return seedDemo(env);
    if (id === 'clear') return clearDemo(env);
  }

  if (resource === 'messages') {
    if (!id && method === 'GET') return handleMessagesList(url, env);
    if (!id && method === 'POST') return handleMessagesQueue(await readJson(request), env);
    if (id && method === 'PATCH' && !action) return handleMessagePatch(id, await readJson(request), env);
    if (id && method === 'POST' && action === 'approve') return handleMessageApprove(id, env);
    if (id && method === 'POST' && action === 'cancel') return handleMessageCancel(id, env);
    if (id && method === 'POST' && action === 'reschedule') return handleMessageReschedule(id, await readJsonOptional(request), env);
    if (id && method === 'POST' && action === 'retry') return handleMessageRetry(id, await readJsonOptional(request), env);
    if (id && method === 'POST' && action === 'needs-review') return handleMessageNeedsReview(id, env);
    if (id && method === 'POST' && action === 'reject') {
      return handleMessageReject(id, await readJsonOptional(request), env);
    }
    if (id && method === 'POST' && action === 'send-now') return handleSendNow(id, env);
  }

  if (resource === 'sender-profiles') {
    if (!id) {
      if (method === 'GET') return handleSenderProfilesList(env);
      if (method === 'POST') return handleSenderProfilePost(await readJson(request), env);
    } else if (!action && method === 'PATCH') {
      return handleSenderProfilePatch(id, await readJson(request), env);
    }
  }

  if (resource === 'campaigns') {
    if (!id) {
      if (method === 'GET') return handleCampaignsList(env);
      if (method === 'POST') return handleCampaignPost(await readJson(request), env);
    } else if (!action) {
      if (method === 'GET') return handleCampaignGet(id, env);
      if (method === 'PATCH') return handleCampaignPatch(id, await readJson(request), env);
    } else if (action === 'leads' && method === 'POST') {
      return handleCampaignLeadPost(id, await readJson(request), env);
    } else if (action === 'clone' && method === 'POST') {
      return handleCampaignClone(id, env);
    } else if (action === 'stop-unsent' && method === 'POST') {
      return handleCampaignStopUnsent(id, env);
    }
  }

  if (resource === 'replies' && !id) {
    if (method === 'POST') return handleReplyPost(await readJson(request), env);
    if (method === 'GET') return handleRepliesList(url, env);
  }

  if (resource === 'stats' && !id && method === 'GET') return handleStats(env);
  if (resource === 'overview' && !id && method === 'GET') return handleOverview(env);

  if (resource === 'admin' && id === 'ai') {
    if (action === 'models' && method === 'GET') return handleAiModelsGet(env);
    if (action === 'model' && method === 'POST') return handleAiModelPost(await readJson(request), env);
  }

  if (resource === 'admin' && id === 'outreach' && action === 'settings') {
    const workspace = await getWorkspaceProfile(env);
    if (method === 'GET') return handleOutreachSettingsGet(env.DB, env, workspace.businessName);
    if (method === 'POST') return handleOutreachSettingsPost(await readJson(request), env.DB, env, workspace.businessName);
  }

  if (resource === 'admin' && id === 'replies' && action === 'debug' && method === 'GET') {
    return handleRepliesDebug(env);
  }

  if (resource === 'suppression') {
    if (!id && method === 'GET') return handleSuppressionList(env);
    if (!id && method === 'POST') return handleSuppressionAdd(await readJson(request), env);
    if (id && method === 'DELETE') return handleSuppressionDelete(id, env);
  }

  throw new HttpError(404, 'Not found');
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/health') {
        await ensureDraftingSchema(env);
        return jsonResponse({ ok: true, service: 'outreach-studio', schema: 'ready' });
      }
      if (url.pathname === '/unsubscribe') {
        return await handleUnsubscribe(request, env);
      }
      if (url.pathname === '/replies/ingest') {
        if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed');
        return await handleReplyIngest(request, env);
      }
      if (url.pathname === '/admin/replies/debug') {
        if (!(await isAuthorized(request, env))) {
          return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
        }
        if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed');
        return handleRepliesDebug(env);
      }
      if (url.pathname === '/admin/ai/models' || url.pathname === '/admin/ai/model') {
        if (!(await isAuthorized(request, env))) {
          return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
        }
        if (url.pathname.endsWith('/models') && request.method === 'GET') return handleAiModelsGet(env);
        if (url.pathname.endsWith('/model') && request.method === 'POST') {
          return handleAiModelPost(await readJson(request), env);
        }
        throw new HttpError(405, 'Method not allowed');
      }
      if (url.pathname === '/admin/outreach/settings') {
        if (!(await isAuthorized(request, env))) return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
        await ensureDraftingSchema(env);
        const workspace = await getWorkspaceProfile(env);
        if (request.method === 'GET') return handleOutreachSettingsGet(env.DB, env, workspace.businessName);
        if (request.method === 'POST') return handleOutreachSettingsPost(await readJson(request), env.DB, env, workspace.businessName);
        throw new HttpError(405, 'Method not allowed');
      }
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        if (!(await isAuthorized(request, env))) {
          return jsonResponse({ ok: false, error: 'Unauthorized' }, 401);
        }
        await ensureDraftingSchema(env);
        return await handleApi(request, env, url);
      }
      if (url.pathname === '/') {
        return env.ASSETS.fetch(request);
      }
      return env.ASSETS.fetch(request);
    } catch (err) {
      if (err instanceof HttpError) {
        return jsonResponse({ ok: false, error: err.message }, err.status);
      }
      if (err instanceof AiError) {
        return jsonResponse({ ok: false, error: `AI (${err.stage}): ${err.message}` }, 502);
      }
      console.error('unhandled error:', err instanceof Error ? (err.stack ?? err.message) : String(err));
      return jsonResponse({ ok: false, error: 'Internal error' }, 500);
    }
  },

  async queue(batch, env): Promise<void> {
    await ensureDraftingSchema(env);
    for (const msg of batch.messages) {
      try {
        if (!msg.body || msg.body.type !== 'send' || !msg.body.messageId) {
          msg.ack();
          continue;
        }
        const outcome = await processSend(env, msg.body.messageId);
        if (outcome.action === 'retry') {
          msg.retry({ delaySeconds: outcome.delaySeconds });
        } else {
          msg.ack();
        }
      } catch (err) {
        console.error('queue consumer error:', err instanceof Error ? err.message : String(err));
        msg.retry({ delaySeconds: 300 });
      }
    }
  },

  async scheduled(controller, env, ctx): Promise<void> {
    ctx.waitUntil((async () => {
      await ensureDraftingSchema(env);
      await runScheduled(controller, env);
    })());
  },
} satisfies ExportedHandler<Env, SendJob>;
