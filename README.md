# Expensify watcher on Cloudflare (free, 24/7)

Every 10 minutes, this checks Expensify/App and paid open-source bounties, and sends your phone an ntfy alert:

- **🚨 Help Wanted: #12345 ($250)** — the issue is open for proposals now.
- **👀 Heads-up: #12345 is External** — likely to open soon. Prepare, but don't post yet.
- **💎 Bounty: calcom/cal.com#123 ($150)** — a new Algora bounty from a company that has paid bounties before.
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
2. **Deploy:**
   ```
   npx wrangler deploy
   ```
   It prints your Worker's address, like `https://expensify-watcher.YOUR-NAME.workers.dev`.
3. **Add your secrets.** Each command asks you to paste a value.
   ```
   npx wrangler secret put GITHUB_TOKEN
   npx wrangler secret put NTFY_TOPIC
   npx wrangler secret put TEST_KEY
   ```
   - `GITHUB_TOKEN`: the token from GitHub.
   - `NTFY_TOPIC`: your ntfy topic name, exactly as in the app.
   - `TEST_KEY`: any random password you make up. It protects the test page.

Within 10 minutes your phone should show **"Expensify watcher is running"**. That's it.

## Check it works

Open this in a browser, with your Worker address and your `TEST_KEY`:

```
https://expensify-watcher.YOUR-NAME.workers.dev/test?key=YOUR_TEST_KEY
```

You should get a **[TEST]** alert for the newest Help Wanted issue.

To test bounty alerts, add `&type=bounty` to the end:

```
https://expensify-watcher.YOUR-NAME.workers.dev/test?key=YOUR_TEST_KEY&type=bounty
```

## Bounty alerts

Any repository can put a "💎 Bounty" label on its own issues, and many that do have never paid anyone. So the watcher
only looks at GitHub organizations whose Algora bounties were actually paid (marked "💰 Rewarded") in 2026:

calcom, activepieces, CapSoftware, permitio, qdrant, archestra-ai, highlight, screenpipe, tursodatabase, golemcloud,
projectdiscovery, tscircuit

To watch a different list, set a `BOUNTY_ORGS` secret with the organization names separated by commas. It replaces the
list above, with no code change:

```
npx wrangler secret put BOUNTY_ORGS
```

For example: `calcom,activepieces,CapSoftware`. To check whether an organization pays, search GitHub for
`label:"💰 Rewarded" org:NAME` and look at the dates.

Bounty alerts start from the moment the bounty watch first runs (you get a **"Bounty watch is on"** message), so
bounties that were already open never alert.

## Useful commands

| What | Command |
|---|---|
| Watch its live log | `npx wrangler tail` |
| Change a secret | `npx wrangler secret put NTFY_TOPIC` (same for the others) |
| Update after editing the code | `npx wrangler deploy` |
| Remove it completely | `npx wrangler delete` |

## How it decides what to send

- Each alert is for one label being added at one time, for example "Help Wanted was added to #12345 at 10:42".
  It is recorded the moment it is sent, so it is never sent twice. If a send fails, only that one alert is
  tried again on the next check.
- Only labels added after you installed the watcher count, so issues that were already open never alert.
- If Expensify removes Help Wanted and adds it back later, that's a new label, so you get a new alert.
- Its memory is a Cloudflare Durable Object. Cloudflare creates it on the first deploy; there's nothing to set up.

## Free plan limits

It makes two small GitHub requests every 10 minutes (one for Expensify, one for bounties), well inside GitHub's
limits, and writes to its storage only when something new happens.
