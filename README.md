# Expensify watcher on Cloudflare (free, 24/7)

Every minute, this checks Expensify/App and sends your phone an ntfy alert:

- **🚨 Help Wanted: #12345 ($250)** — the issue is open for proposals now.
- **👀 Heads-up: #12345 is External** — likely to open soon. Prepare, but don't post yet.
- **⚠️ Expensify watcher error** — something broke (for example, an expired token). At most one every 6 hours.

It runs on Cloudflare's free Workers plan, so your computer doesn't need to stay on.

## What you need

- A free Cloudflare account: https://dash.cloudflare.com/sign-up
- Node.js 20 or newer on your computer: https://nodejs.org (the LTS installer)
- The ntfy app on your phone, subscribed to your topic name
- A GitHub token: GitHub → Settings → Developer settings → Personal access tokens →
  **Fine-grained tokens** → Generate new token. Choose **Public repositories (read-only)**,
  give it a long expiry, and add no permissions. Copy the token.

## Deploy (about 10 minutes)

Clone this repo (or download it as a ZIP from GitHub and unzip it), open a terminal (Windows: PowerShell) in its folder, then:

1. **Log in to Cloudflare.** A browser window opens; click Allow.
   ```
   npx wrangler login
   ```
2. **Create the storage** the watcher uses to remember what it already told you:
   ```
   npx wrangler kv namespace create STATE
   ```
   It prints an `id = "..."`. Open `wrangler.toml` and replace `PASTE_YOUR_KV_NAMESPACE_ID_HERE`
   with that id.
3. **Deploy:**
   ```
   npx wrangler deploy
   ```
   It prints your Worker's address, like `https://expensify-watcher.YOUR-NAME.workers.dev`.
4. **Add your secrets.** Each command asks you to paste a value.
   ```
   npx wrangler secret put GITHUB_TOKEN
   npx wrangler secret put NTFY_TOPIC
   npx wrangler secret put TEST_KEY
   ```
   - `GITHUB_TOKEN`: the token from GitHub.
   - `NTFY_TOPIC`: your ntfy topic name, exactly as in the app.
   - `TEST_KEY`: any random password you make up. It protects the test page.

Within a minute or two your phone should show **"Expensify watcher is running"**. That's it.

## Check it works

Open this in a browser, with your Worker address and your `TEST_KEY`:

```
https://expensify-watcher.YOUR-NAME.workers.dev/test?key=YOUR_TEST_KEY
```

You should get a **[TEST]** alert for the newest Help Wanted issue.

## Useful commands

| What | Command |
|---|---|
| Watch its live log | `npx wrangler tail` |
| Change a secret | `npx wrangler secret put NTFY_TOPIC` (same for the others) |
| Update after editing the code | `npx wrangler deploy` |
| Remove it completely | `npx wrangler delete` |

## Free plan limits

It makes one small GitHub request a minute, well inside GitHub's limits. It writes to storage only
when something changes, well inside Cloudflare's free limit of 1,000 writes a day.
