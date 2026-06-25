---
name: google-workspace-reauth
description: Re-authenticate Google Workspace MCP for a specific Google account when the token expires or access is revoked. Trigger on: "reauth google workspace", "google workspace auth", "gmail auth expired", "refresh google token", "google auth not working", "workspace token expired".
---

# Google Workspace Re-Authentication

Use this skill when the Google Workspace MCP token has expired or been revoked for an account.

## Critical Rule

**NEVER manually construct the OAuth URL.** Always use the `mcp__GoogleWorkspace__start_google_auth` MCP tool. The server manages OAuth state (PKCE, state token) internally — a manually built URL will not work because the server won't have the matching state to complete the exchange.

## Architecture Reference

- Google Workspace MCP runs on port **3005** (not 3000, not 3001)
- Redirect URI: `http://localhost:3005/oauth2callback` — managed internally by the MCP server
- Tokens stored at: `/workspace/project/data/gworkspace-creds/<email>.json`
- This is a **separate OAuth system** from the old inbox pipeline (`auth-setup.js` / port 3000) — do not confuse them or use `auth-setup.js` as a reference

## Steps

### 1. Identify the account

Default account: `edencheng@gmail.com`. Ask the user if a different account is needed.

### 2. Call `start_google_auth` via MCP tool

```
mcp__GoogleWorkspace__start_google_auth(
  service_name="gmail",
  user_google_email="edencheng@gmail.com"
)
```

The tool returns a full authorization URL with all scopes, PKCE challenge, and state token. Use this URL exactly as returned — do not modify it.

### 3. Send to user as a Telegram hyperlink

Format the message as:

```
[🔗 Authorize Google Workspace for <email>](<url>)
```

Then instruct the user:
- Click the link and sign in as the correct Google account
- Approve all requested permissions on the consent screen
- Once redirected to `localhost:3005`, the token saves automatically — no code to paste back
- Reply "done" when complete

### 4. Verify after user confirms

Call a lightweight API to confirm the token is live:

```
mcp__GoogleWorkspace__search_gmail_messages(
  query="in:inbox",
  user_google_email="edencheng@gmail.com",
  page_size=3
)
```

If results return → confirm success to the user with ✅.
If an auth error is thrown → check that user signed in with the correct account, then retry from Step 2.

## Troubleshooting

- **"redirect_uri_mismatch"** — Port 3005 may not be accessible. Check: `docker ps | grep google_workspace_mcp`
- **Wrong Google account signed in** — Google defaulted to a different logged-in account in the browser. Ask user to use Incognito mode or sign out of other Google accounts first.
- **Token file unchanged after auth** — The callback at `localhost:3005` wasn't received. Check the token file: `cat /workspace/project/data/gworkspace-creds/edencheng@gmail.com.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('expiry_date','no expiry'))"`. If still old, retry from Step 2.
- **MCP returns auth errors after successful token save** — Restart the GWorkspace MCP container: `docker restart <container_name>`
