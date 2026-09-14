# n8n workflows

n8n is an optional integration layer for lead intake, reply transport, and daily summaries. Outreach Studio remains the source of truth for profile context, suppression, draft approval, and send state.

## Zoho reply monitoring

1. Store the deployment's `N8N_WEBHOOK_SECRET` in an n8n credential sent as the `x-n8n-webhook-secret` header.
2. Poll only the Zoho inbox used by the verified sender. Replace the sender address in the workflow code and the Worker base URL before activating it.
3. Poll unread messages every few minutes. Exclude the sender's own address, delivery folders, and messages with your `outreach-studio-processed` label. Fetch the plain-text body and `Message-ID`, `In-Reply-To`, and `References` headers.
4. POST each reply to `https://<your-worker>/replies/ingest`. Mark it read and processed only after the Worker returns HTTP 2xx with `ok: true`.
5. Notify the owner for positive replies and `manual_review`; never send the suggested reply automatically.

Example payload (use a fictional domain for test values):

```json
{
  "from_email": "prospect@example.com",
  "from_name": "Prospect Name",
  "subject": "Re: A useful next step",
  "body": "Plain-text reply",
  "received_at": "2026-07-16T09:15:00Z",
  "message_id": "<unique-inbound-message-id@example.com>",
  "in_reply_to": "<outbound-message-id@yourdomain.example>",
  "references": "<outbound-message-id@yourdomain.example>",
  "raw_payload": {}
}
```

Use unread-only polling, the processed label, and the stable `message_id` as duplicate guards. The Worker deduplicates message IDs if n8n retries delivery.

## Intake and daily digest

- The Google Sheets intake workflow expects columns such as `email`, `first_name`, `last_name`, `role`, `company`, `website`, `industry`, and `notes`. Configure the Worker URL and API credential before enabling it.
- The daily digest workflow requires an authenticated Outreach Studio API credential and a Telegram chat ID. Set its schedule to the owner’s timezone.
- Keep the reply workflow's IMAP `postProcessAction` set to `nothing` until the Worker confirms ingest. Never let an integration skip human approval or directly send generated replies.
