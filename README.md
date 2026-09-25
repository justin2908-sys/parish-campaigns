# Parish Campaigns System — St. Vincent De Paul Church, Osterley, London

## v1.8 — important fixes, read this one

**Bug fix (v1.0–v1.7):** the database only ever allowed ticket status values
`unsold / cash_pending / paid / void`, but the code was writing `paid_pending`
for every card sale — a value the database silently rejected. This means
**every card sale attempt before v1.8 would have failed** at the point of
claiming the ticket. Cash sales were unaffected. Fixed by correcting the
allowed status to `held` and updating all code paths to use it.

**Policy change — no auto-release of held tickets.** Since physical tickets
are handed to the buyer at the point of sale (trust-based, in person), a
ticket that's `held` for a card payment now **never** automatically reverts
to `unsold`, even if the payment stalls, fails, or the SumUp link expires.
The physical ticket is already with a real person — releasing it back into
the pool would let it be sold twice. Instead:
- The *payment* record gets marked `failed` so it surfaces in **Needs
  Attention**, and an Admin/SuperAdmin resends a fresh link.
- The *ticket* only ever returns to `unsold` through an explicit Admin
  **Void** — a deliberate decision, never a timeout.


## What's already done
- Database schema created in your existing Supabase project (`yaqoysqpalzmxegjqvax`):
  tables `bbq_users`, `bbq_series`, `bbq_tickets`, `bbq_payments`, `bbq_cash_recon`.
  RLS is fully locked — no direct browser access. Everything goes through the one
  backend function below, which is the only thing holding your secret keys.

## Deploy steps (you do these — none of them involve giving me any secrets)

### 1. Deploy this folder to Netlify
Easiest path: drag this whole folder into Netlify's "Deploys" page on a new site
(same way you deployed the survey dashboard), or connect it to a GitHub repo if
you'd rather. Netlify will detect `netlify.toml` automatically.

### 2. Set environment variables in Netlify
Site settings → Environment variables → add:

| Key | Where to find it |
|---|---|
| `SUPABASE_URL` | Supabase project → Settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase project → Settings → API → `service_role` secret key (NOT the anon key) |
| `SUMUP_API_KEY` | SumUp → Developer Settings → API keys → create a live secret key (`sk_live_...`) |
| `SUMUP_MERCHANT_CODE` | SumUp dashboard → Account → shows your merchant code |
| `SESSION_SECRET` | Any long random string you make up yourself — used to sign login sessions |

Redeploy the site after adding these (Netlify needs a redeploy to pick up new env vars).

### 3. First-time setup (in the app itself, not with me)
Open the deployed site → "First-time SuperAdmin setup" → enter your own name,
mobile number, and a password only you know. This only works once, before any
other users exist — it's disabled automatically after that.

### 4. Add your team
Log in as SuperAdmin → Users tab:
- Add each Volunteer Seller with their mobile number and **the one shared
  password** you've agreed with them.
- Add any other Admins with their own individual passwords.

### 5. Create your ticket series
Admin/SuperAdmin → Series tab → e.g. name `BBQ26`, range `30001`–`30300`,
Adult £12, Child £5. This immediately generates all 300 tickets as "unsold" —
nothing more to configure.

## On the day
- Sellers log in on their phone/tablet, enter ticket numbers + Adult/Child as
  they sell, choose Cash or Card. Card shows a QR the buyer scans with their
  own phone to pay — no reader pairing needed for this flow.
- Cash sales just get logged; sellers hand the physical cash to an Admin later.
- Admins use Cash Recon to confirm cash (enter the lump sum, it auto-matches
  oldest-first against that seller's pending sales).
- Dashboard tab gives you live sold/unsold, card vs cash, seller breakdown,
  and a data-integrity check that flags itself if anything doesn't add up.

## Notes
- Nothing here ever asks you to paste a password or API key to me — you enter
  all of those directly into Netlify/Supabase/the app itself.
- This is v1.0. Known intentional scope limits: no ticket editing after a sale
  besides Void (admin-only, requires a reason), no receipt printing (SumUp's
  own receipt options work if the buyer wants one).
- **Deploying (credit-aware).** Each production deploy costs Netlify credits (15); deploy previews
  and branch deploys are free. So:
  - Work on the `dev` branch. A pull request from `dev` to `main` gets a **free deploy preview**
    with its own web address — test there.
  - Production only builds when a commit message contains `PUBLISH-NOW` (see the credit guard in
    `netlify.toml`); any other push to `main` is skipped. To publish: merge the PR with a message
    ending in `PUBLISH-NOW`.

