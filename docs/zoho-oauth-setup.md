# Zoho Mail setup for a new deployment

Each Outreach Studio deployment connects to its own Zoho Mail account and uses a sender address that Zoho has approved for that account. Keep the Worker in `DRY_RUN=true` until OAuth, sender verification, and a controlled test are complete.

Zoho’s send-message API uses the authenticated account ID and the `ZohoMail.messages.CREATE` scope. The account ID is returned by the accounts API. See the official [send email API](https://www.zoho.com/mail/help/api/post-send-an-email.html), [OAuth guide](https://www.zoho.com/mail/help/api/using-oauth-2.html), and [accounts API](https://www.zoho.com/mail/help/api/account-api.html).

## 1. Choose the correct Zoho data center

Use the OAuth and Mail API hosts for the data center where the mailbox is registered. The sample values in `wrangler.jsonc` use Zoho’s global `.com` hosts; change `ZOHO_ACCOUNTS_BASE` and `ZOHO_MAIL_BASE` if your account uses another Zoho region.

## 2. Create OAuth credentials

1. Sign in as the owner of the Zoho Mail account and open the [Zoho API Console](https://api-console.zoho.com/).
2. Create a **Self Client** for this deployment.
3. Generate a short-lived grant code with these comma-separated scopes:
   `ZohoMail.messages.CREATE,ZohoMail.accounts.READ`
4. Exchange the grant code at your region’s `/oauth/v2/token` endpoint. Use the values from the API Console:

   ```powershell
   $response = Invoke-RestMethod -Method Post -Uri "https://accounts.zoho.com/oauth/v2/token" -Body @{
     grant_type    = "authorization_code"
     code          = "<GRANT_CODE>"
     client_id     = "<CLIENT_ID>"
     client_secret = "<CLIENT_SECRET>"
   }
   $response
   ```

5. Store the returned refresh token somewhere secure. Do not commit the grant code, access token, refresh token, or client secret.

## 3. Find the account ID and configure the sender

Use the access token from that exchange to list the user’s Mail accounts, then copy the matching `accountId` into `ZOHO_ACCOUNT_ID` in `wrangler.jsonc`:

```powershell
Invoke-RestMethod -Uri "https://mail.zoho.com/api/accounts" -Headers @{
  Authorization = "Zoho-oauthtoken <ACCESS_TOKEN>"
} | ConvertTo-Json -Depth 5
```

In Zoho Mail, verify the From address and display name under **Send Mail As**. Use that exact address in the Outreach Studio setup wizard and confirm the identity there. Zoho only permits a From address associated with the authenticated account.

## 4. Store credentials in Cloudflare

From the Worker project directory, store each value as a secret (substitute your values when prompted):

```powershell
wrangler secret put ZOHO_CLIENT_ID
wrangler secret put ZOHO_CLIENT_SECRET
wrangler secret put ZOHO_REFRESH_TOKEN
```

For local development, copy `.dev.vars.example` to `.dev.vars` and fill in the same secrets. Never commit `.dev.vars`. Set `FROM_EMAIL`, `FROM_NAME`, and `ZOHO_ACCOUNT_ID` to your deployment’s verified account values, and start with `DRY_RUN=true`.

## 5. Optional reply monitoring

If you use the included n8n workflows, configure Zoho IMAP access and an app password for the same reply inbox. Set the workflow’s sender email, Worker URL, and webhook secret to deployment-specific values. The workflow only ingests replies; it never sends suggested replies.

## Troubleshooting

- `INVALID_OAUTHTOKEN`: check the refresh token, the selected Zoho data center, and OAuth scopes.
- 404 or invalid account: confirm `ZOHO_ACCOUNT_ID` belongs to the authenticated Zoho Mail account and matches the selected data center.
- Sender rejected: confirm the exact From address is enabled under Zoho **Send Mail As**.
- Mail reaches spam: configure SPF, DKIM, and DMARC for your sending domain and start with conservative caps.
