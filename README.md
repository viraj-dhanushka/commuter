# commutai.com — for sale

The landing page for **commutai.com**, a brandable .com for an AI commute companion, transit planner or mobility product.

It runs as a single Cloudflare Worker:

- `public/` — the static sale page (served by Workers static assets)
- `src/index.js` — handles `/api/config` and `/api/contact`
- Offers are protected by **Cloudflare Turnstile** (verified server-side, including action and hostname checks) plus a honeypot field
- Offers are emailed to the owner through the **Cloudflare Email Service** `send_email` binding, with **Reply-To** set to the sender

The owner's email address is never in this repository or in the page. It is stored only as the `CONTACT_TO` secret on the Worker.

## Deploy

All steps happen in the Cloudflare account that holds commutai.com.

### 1. Create a Turnstile widget

Dashboard → **Turnstile** → **Add widget**

- Hostnames: `commutai.com`, `www.commutai.com`
- Mode: Managed

Keep the **site key** and **secret key**.

### 2. Enable email sending for the domain

Dashboard → **Email** → **Email Sending** → onboard `commutai.com` (adds SPF/DKIM DNS records automatically), or:

```sh
npx wrangler email sending enable commutai.com
```

The page sends from `offers@commutai.com` (change `MAIL_FROM` in `wrangler.jsonc` if you like).

### 3. Deploy the Worker

Connect this repo in Dashboard → **Workers & Pages** → **Create** → **Import a repository** (Workers Builds deploys on every push), or from a terminal:

```sh
npm install
npx wrangler login
npx wrangler deploy
```

`wrangler.jsonc` attaches the Worker to `commutai.com` and `www.commutai.com` as custom domains. Remove any old DNS records or parking redirects on those hostnames first.

### 4. Add the secrets and site key

```sh
npx wrangler secret put CONTACT_TO          # the inbox that receives offers
npx wrangler secret put TURNSTILE_SECRET    # Turnstile secret key
```

Then in Dashboard → the Worker → **Settings** → **Variables and Secrets**, add a plain-text variable `TURNSTILE_SITE_KEY` with the Turnstile site key. (`keep_vars` in `wrangler.jsonc` keeps it across deploys.)

### 5. Test

Open https://commutai.com, send yourself an offer, and reply to the email you receive. The reply goes to the sender.

## Local development

```sh
cp .dev.vars.example .dev.vars   # uses Cloudflare's always-pass Turnstile test keys
npm install
npx wrangler dev
```

Local mode simulates email sending; nothing is delivered.
