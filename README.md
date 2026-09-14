# Outreach Studio

Outreach Studio is a self-hosted workspace for researching leads and preparing tailored business-to-business email outreach. Configure a business profile once, organize leads into campaigns, generate profile-aware drafts, and review each message before it can be sent through your own Zoho Mail account.

The project is designed for one owner and one business profile per deployment. It is not a hosted multi-tenant service. Its fictional demo uses a software-and-visual-design studio and sample contacts; demo messages can be scored and drafted, but the server prevents approval, queueing, and sending.

## What it does

- Scores leads against your services, ideal customer, target industries and roles, geography, and stated pain points.
- Drafts outreach using your business profile and campaign brief. Campaigns can refine the audience, offer, tone, CTA, and templates without changing the workspace's business identity.
- Provides lead, campaign, draft review, send queue, sent history, reply triage, and suppression workflows.
- Requires human approval before delivery and applies send caps, send windows, suppression checks, and duplicate-send safeguards.
- Stores a profile and messaging snapshot with each new message. Sent messages remain unchanged; older unsent drafts need review and regeneration under the current profile.
- Offers optional n8n workflows for lead intake, reply monitoring, and daily summaries. Generated reply suggestions are not sent automatically.

Outreach Studio does not scrape websites automatically, discover contacts, or send without an operator's approval.

## Try the demo

The demo is fictional and safe for exploring the interface. It includes a sample business profile and three fictional leads using reserved `.example` email domains. Choose **Explore the demo** in the first-run wizard, or use **Load safe demo** in Settings. A persistent Demo badge indicates that sending is disabled.

Leaving demo mode removes only demo-tagged leads, drafts, and associated demo activity, then lets you configure your own profile. Demo setup is intended for a fresh workspace; it will not overwrite real leads or an existing business profile.

## Run locally

### Requirements

- Node.js supported by the installed Wrangler version
- pnpm 10.11 or later
- A Cloudflare account and AI Gateway token for AI scoring and drafting
- A Zoho Mail account only if you plan to test real delivery

### Setup

```sh
git clone https://github.com/AbdulRGadu/openreach.git
cd openreach
pnpm install --frozen-lockfile
```

Copy `.dev.vars.example` to `.dev.vars` and set local credentials. For PowerShell, use `Copy-Item .dev.vars.example .dev.vars`.

At minimum, set a private six-digit `DASHBOARD_PIN` and a long random `API_KEY`. Add `CF_AI_TOKEN` and configure your Cloudflare account and AI Gateway values in `wrangler.jsonc` to use AI scoring and drafting. Zoho secrets and a verified sender are needed only to exercise real delivery. `N8N_WEBHOOK_SECRET` is needed only if you enable the optional reply-ingest workflow. Never commit `.dev.vars` or put secrets in `wrangler.jsonc`.

Apply migrations to Wrangler's local D1 database and start the Worker:

```sh
pnpm db:migrate:local
pnpm dev
```

Open [http://127.0.0.1:8788/admin](http://127.0.0.1:8788/admin), enter the dashboard PIN, and follow the setup wizard. Keep `DRY_RUN` set to `true` in `wrangler.jsonc` while developing. Local D1 and Queue state is stored under Wrangler's local state directory; do not commit that state.

### Useful commands

```sh
pnpm dev                 # Run Wrangler locally on 127.0.0.1:8788
pnpm check               # Type-check TypeScript
pnpm test                # Run the Node test suite
pnpm db:migrate:local    # Apply D1 migrations locally
pnpm db:migrate:remote   # Apply D1 migrations to the configured Cloudflare database
pnpm deploy              # Deploy the Worker and static assets
```

## Configure a deployment

Each deployment needs its own Cloudflare resources, AI Gateway configuration, Zoho OAuth credentials, and verified sender identity. Do not reuse credentials from another installation.

1. Create a Cloudflare D1 database named `outreach-studio-db` (or update the name in `wrangler.jsonc`) with `pnpm exec wrangler d1 create outreach-studio-db`. Copy the returned database ID into `d1_databases[0].database_id`.
2. Create the two Cloudflare Queues referenced by the Worker: `pnpm exec wrangler queues create outreach-send` and `pnpm exec wrangler queues create outreach-send-dlq`.
3. In `wrangler.jsonc`, set your Cloudflare account ID, AI Gateway ID, Zoho data-center URLs and Mail account ID, public Worker URL, timezone, and verified `FROM_EMAIL` / `FROM_NAME`. Keep `DRY_RUN` set to `true` during setup.
4. Add deployment secrets interactively with `pnpm exec wrangler secret put NAME`. Required dashboard and AI secrets are `DASHBOARD_PIN`, `API_KEY`, and `CF_AI_TOKEN`. For Zoho delivery also set `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`, and `UNSUB_SECRET`. Set `N8N_WEBHOOK_SECRET` only when using the n8n reply-ingest workflow. Never paste secret values into tracked files or command-line arguments.
5. Apply the database migrations and deploy:

   ```sh
   pnpm db:migrate:remote
   pnpm deploy
   ```

6. Open `https://<your-worker>/admin` and complete the wizard with the real business profile and Zoho-verified sender. Send a controlled test while dry-run is enabled. Only set `DRY_RUN` to `false` once OAuth, sender identity, unsubscribe behavior, and approval workflows are verified.

For Zoho Self Client setup, data-center selection, sender verification, and troubleshooting, see [docs/zoho-oauth-setup.md](docs/zoho-oauth-setup.md). Cloudflare resource setup is managed through Wrangler and the Cloudflare dashboard; `wrangler.jsonc` contains placeholders, not production account values.

## Business profile and campaigns

The first-run wizard and **Settings → Business profile** configure:

- Business name, industry, description, services, and website
- Ideal customer, target industries and roles, geography, and relevant pain points
- Differentiators, the offer, a single-question call to action, and writing tone
- Claims and statements to avoid
- Sender profile, signature, and Zoho-verified From identity

Complete the required profile and sender setup before scoring, drafting, approval, or delivery. Add leads through the dashboard or authenticated API, then assign them to campaigns and review generated drafts. Profile edits guide new messages; saved message snapshots preserve the context used when existing work was drafted.

## API overview

Dashboard and `/api/*` routes require `Authorization: Bearer <DASHBOARD_PIN-or-API_KEY>`. The web dashboard uses the PIN. Use the API key for scripts and integrations, and keep it private. The reply-ingest endpoint is separately protected by `N8N_WEBHOOK_SECRET` in the `x-n8n-webhook-secret` header. `/health` is public and reports Worker/schema readiness.

Common authenticated routes:

| Route | Purpose |
| --- | --- |
| `GET /api/onboarding` | Check profile and sender setup status |
| `GET /api/workspace-profile` / `PUT /api/workspace-profile` | Read or update business context |
| `POST /api/demo/seed` / `POST /api/demo/clear` | Load or leave the safe demo |
| `GET /api/leads` / `POST /api/leads` | List or import leads |
| `POST /api/leads/:id/score` / `POST /api/leads/:id/draft` | Score a lead or generate a draft |
| `GET /api/campaigns` / `POST /api/campaigns` | List or create campaigns |
| `GET /api/messages` / `POST /api/messages/:id/approve` | Review messages and approve a draft |
| `GET /api/replies` / `GET /api/suppression` | Review replies or suppression entries |

All API routes except `/health` require authentication. Demo mode is enforced on the server, not just hidden in the interface. See `src/index.ts` for the complete route map and request handlers.

## Architecture

- **Cloudflare Worker** serves the API, dashboard assets, scheduled jobs, and queue consumer.
- **D1** stores the workspace profile, leads, campaigns, message snapshots, delivery state, replies, and suppression records. Migrations are in `migrations/`.
- **Cloudflare Queues** stage approved outbound messages and route repeated failures to a dead-letter queue.
- **Cloudflare AI Gateway** calls the configured model for lead scoring and draft generation. Prompt context is built from the workspace profile, campaign brief, and untrusted lead facts.
- **Zoho Mail API** is the only outbound delivery integration. Optional n8n workflows are in `n8n/`.

The app is for a single workspace and does not provide multi-user accounts, role-based access, or tenant isolation. If exposing the dashboard publicly, add an appropriate access layer and protect the deployment secrets and database.

## Safety and privacy

- Review every message before approving it. Automation cannot bypass human approval.
- Start with dry-run enabled and conservative caps. Test with an address you control before enabling delivery.
- Demo mode can never approve, queue, or send email.
- Respect applicable email, privacy, and anti-spam laws. Configure a valid business identity and any required physical mailing address, and honor opt-outs promptly. The software is not legal advice and cannot determine whether a contact is appropriate to email.
- Treat lead data as untrusted input. Do not include sensitive personal information that is not needed for legitimate business outreach.
- Keep Cloudflare, Zoho, and n8n credentials in secrets storage. `.dev.vars`, Wrangler state, and local databases are ignored by Git; verify your own deployment and backups before sharing data or logs.

## Troubleshooting

- **Dashboard says unauthorized:** confirm `.dev.vars` contains the same six-digit `DASHBOARD_PIN` you entered, then restart `pnpm dev`.
- **Profile setup blocks scoring or drafting:** open Settings and fill each required business-profile field and configure an active, verified sender for a real business. The demo is exempt from sender setup but remains send-disabled.
- **AI scoring/drafting fails:** confirm `CF_AI_TOKEN`, `CF_ACCOUNT_ID`, `AI_GATEWAY_ID`, and model availability. Check the AI Gateway and Workers AI permissions on the token.
- **Zoho rejects delivery:** verify the OAuth data center, refresh token scopes, `ZOHO_ACCOUNT_ID`, and that `FROM_EMAIL` is enabled under Zoho's **Send Mail As** settings. Keep dry-run enabled while diagnosing. See [Zoho setup](docs/zoho-oauth-setup.md).
- **A legacy draft cannot be sent:** regenerate it under the current business profile, then review and approve the new draft.

## Contributing

Install dependencies with `pnpm install --frozen-lockfile`, run `pnpm check` and `pnpm test`, and keep secrets and real contact data out of pull requests and test fixtures. Tests use fictional example data; do not replace it with personal or customer records.

## License

This repository is public, but it currently has no `LICENSE` file. Until a license is selected and added, others do not have an explicit license to reuse, modify, or redistribute this code. Add a license before describing the project as legally open source.
