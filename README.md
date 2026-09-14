# Outreach Studio

Outreach Studio is a self-hosted AI outreach workspace for one business. Add a business profile and leads, create tailored email drafts, review each message, and send through your own Zoho Mail account. It has a fictional demo mode for portfolios and trials; the backend blocks every demo send.

## Local development

1. Install dependencies with `pnpm install --frozen-lockfile`.
2. Copy `.dev.vars.example` to `.dev.vars` and supply local secrets. Keep `DRY_RUN=true` in `wrangler.jsonc` while testing.
3. Create the local D1 database and queues, then run `pnpm db:migrate:local` and `pnpm dev`.
4. Open `http://127.0.0.1:8788/admin`, enter the dashboard PIN, and follow the four-step setup. Choose the fictional demo or enter your business and verified sender details.

The profile stores business name, industry, description, services, target audience, pain points, differentiators, offer, CTA, tone, geography, and claims to avoid. Campaign briefs may refine a draft without replacing the business identity. Every new message snapshots its profile, messaging, and campaign brief; sent mail is never rewritten. Legacy unsent drafts are moved to review and must be regenerated.

## Cloudflare deployment

1. Create a Cloudflare D1 database and replace the `database_id` placeholder in `wrangler.jsonc`. The configured database name is `outreach-studio-db`.
2. Create the `outreach-send` and `outreach-send-dlq` queues used by the Worker.
3. Set the Cloudflare account, AI Gateway, Zoho data-center/account values, public Worker URL, timezone, and your verified `FROM_EMAIL` / `FROM_NAME` in `wrangler.jsonc`.
4. Add secrets with `wrangler secret put`: `DASHBOARD_PIN`, `API_KEY`, `CF_AI_TOKEN`, `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`, `N8N_WEBHOOK_SECRET`, and `UNSUB_SECRET`.
5. Apply remote D1 migrations with `pnpm db:migrate:remote`, deploy with `pnpm deploy`, then complete setup in `/admin`. See [Zoho OAuth setup](docs/zoho-oauth-setup.md) for credentials and sender verification.

Keep the Worker in dry-run mode until the test mailbox and sender are verified. Set `DRY_RUN=false` only when you are ready for approved messages to reach real recipients. Dashboard authentication has no shared PIN fallback.

## Delivery safeguards

- Every real outbound email requires a human approval; campaign automation cannot bypass it.
- Demo mode can score and draft, but cannot approve, queue, or send.
- Sender identities must be verified in Zoho. Suppression, send caps, send windows, and the one-email rule remain enforced.
- Zoho OAuth credentials, Cloudflare account details, and sender identities belong to each deployment and must not be committed.
- Website research is manual. Outreach Studio does not scrape business sites automatically.

## Verify changes

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm test
```
