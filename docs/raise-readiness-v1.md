# RAISE — platform readiness review (v1, 2026-10-27)

Written after the St.Vincent De Paul build, to decide what must change before this is sold to other parishes, schools, universities and
other institutions. Every statement marked **(checked)** was verified in the code or the live database on 2026-10-27; the rest are
judgement calls and say so. This is not legal advice.

## 1. What RAISE is today

One web app (Netlify) over one Postgres database (Supabase, free plan), reached only through one server function (`api.js`, 100 actions,
85 behind a login, 15 open to the public). It already has an Organisation layer above Campaign, a Platform Owner role, five staff roles
(SuperAdmin, Admin, Finance, Priest, Seller), and four things an institution can run: **raffles**, **ticket events**, **registrations**
(with or without payment, approval, waiting list, file upload) and a **public page** per organisation (`/go/<address>`). It has retention
(automatic deletion), a privacy screen, a books check, and a SumUp check. Size today: 17 MB, 1 organisation, about 10,000 tickets.

## 2. Verdict

**Ready to run for St.Vincent's. Not ready to sell.** The product is strong; the platform around it is not built. Roughly:

| Area | State | Why |
|---|---|---|
| Features (raffles, events, registrations, gateway page) | **Strong** | Complete, tested, used for real money |
| Data model (organisation above campaign) | **Good start** | Every table reaches an organisation; one gap below (mobile numbers) |
| Isolation between customers | **Unproven** | Held up only by application code (see 3.1) |
| Taking payment | **Blocker** | One SumUp account for the whole site (3.2) |
| Branding / vocabulary / country | **Weak** | Church, UK, £ and St.Vincent's are baked in (3.3) |
| Accounts and access | **Weak** | Mobile + password only, no email, no 2-step, no self-service reset (3.4) |
| Signing up, plans, billing, leaving | **Missing** | Platform Owner creates an organisation by hand (3.5) |
| Legal and compliance | **Partial** | Privacy tooling good; no RAISE-level terms, processor agreement or sub-processor list (3.6) |
| Reliability and operations | **Weak** | Free plans, no staging database, no monitoring, no restore plan (3.7) |
| Code and testing | **Fragile** | Two big files; tests exist only for recent work; repo and live database had drifted (3.8) |

## 3. Findings

### 3.1 Isolation between customers
- The browser never talks to the database (row security is on with no policies; **checked**: the Supabase security check reports only the
  expected "no policies" notices). Everything goes through one server function using the all-powerful service key.
- That means **customer separation is only as good as every one of 85 handlers remembering to check the organisation** (**checked**:
  67 role checks and 24 organisation filters in the file). One forgotten filter lets one customer read or change another's data.
- The gateway was tested for this (organisation A cannot touch B). **The other ~80 actions have never been tested that way.**
- **Fix (Step 1):** an automated sweep that calls every action as organisation A using organisation B's ids and fails if anything is
  read, changed or leaked; then, as defence in depth, make the database itself refuse cross-organisation access.
- `users.mobile` is unique across the whole site (**checked**): one person cannot work for two institutions, and two institutions cannot
  both have "07700 900123". Needs to become unique per organisation, with login naming the organisation (or moving to email).

### 3.2 Payments — the blocker
- SumUp is configured once, in site settings (`SUMUP_API_KEY`, `SUMUP_MERCHANT_CODE`; **checked**: 15 uses in `api.js`, none per organisation).
  A second customer's ticket money would land in **St.Vincent's SumUp account**.
- Currency is fixed at GBP (**checked**: two places) and "£" appears in about 70 places on the screens.
- **Principle: the money must go straight from the buyer to the institution's own account. It must never pass through, or sit with, RAISE.**
  Holding other people's money and paying it out is a regulated activity in the UK; avoiding it is also simpler. Get proper legal and
  accountancy advice before designing any fee taken from payments.
- **Fix (Step 2):** each organisation connects its own account (SumUp now, a second provider such as Stripe later, behind one internal
  interface); key stored encrypted per organisation; payment notifications routed to the right organisation; currency per organisation;
  the existing "Test SumUp connection" and the books check run per organisation. St.Vincent's moves over as organisation number one.
- RAISE earns by **subscription**, not by taking a cut of each payment (SumUp has no mechanism for a platform fee; Stripe Connect does).

### 3.3 Made for one church in one country
- Screens: the title, header and ticket page carry "St.Vincent De Paul Church" (**checked**, 8 lines); "church" and "parish" run through
  about 80 lines of wording; the Sacrament form template quotes the Westminster consent wording.
- Law and rules that are **UK-specific**: raffles are society lotteries registered with the local council (certificate shown on the page);
  the "18 or over" line; UK GDPR; "Europe/London" is used for dates (**checked**: server and the nightly deletion job); retention is a fixed
  90 days (**checked**: one constant). Outside the UK a raffle can be illegal without a licence, so **raffles must be switchable per
  organisation and off by default** until a country's rules are understood.
- The theme is one palette (pine green and brass) in one stylesheet. The gateway page already uses per-organisation colour variables.
- **Fix (Step 3):** settings per organisation (country, currency, time zone, language, retention days, which features are on), a wording
  set per kind of institution (church, school, university, generic) instead of scattered text, per-organisation logo and colours across
  the whole app (the gateway's Phase 2 does this for the public page), and removing every baked-in St.Vincent's string.

### 3.4 Accounts and access
- Staff log in with mobile + password only. There is no email on a user (**checked** in the schema), no self-service "forgot password"
  (the SuperAdmin resets it), no two-step sign-in, and the Platform Owner (you) has no recovery path at all.
- For a product that handles money and children's records, **Admin, Finance and SuperAdmin need two-step sign-in and email recovery.**
- No activity log of who changed what outside the privacy screen.
- **Fix (Step 4):** email-based accounts, password reset by email, two-step sign-in for the money roles, an activity log, a recovery path
  for you, and a support-access feature (a customer lets you in for a limited time, recorded).

### 3.5 The business layer does not exist
- Creating a customer today is: you add an organisation row (`create_organization`: just a name), then create its SuperAdmin.
- Missing: self-service sign-up and a first-run setup wizard, trial, plans and limits, billing, suspending a non-payer, exporting a
  customer's data and deleting them when they leave (UK GDPR requires you to be able to), and a usage view for you.
- **Fix (Step 5).**

### 3.6 Legal and compliance (your side, not just code)
- Each institution is the **controller** of its people's data and RAISE is its **processor**: you need standard terms, a short data
  processing agreement and a published list of sub-processors (Supabase, Netlify, SumUp, plus any email or billing vendor). The earlier
  Hall Booking decision (the Diocese is the controller for Westminster parishes) still applies to Catholic parishes there.
- **Data location:** the database is in Ireland but the server function runs in the US (Netlify free plan; **checked** in earlier work).
  Fine for St.Vincent's with disclosure; for schools and universities you will be asked. Move the function to the EU/UK when the
  hosting plan allows.
- **The name:** "RAISE" is a common word. I have **not** searched, but it is likely already used by other fundraising, finance or
  education products. Do a trademark and domain search (UK IPO, EUIPO) **before** investing in branding. A distinctive spelling or a
  "RAISE by …" lock-up is usually safer.
- Charities and schools will ask about Gift Aid and donations. These are deliberately not built.

### 3.7 Reliability and operations
- **Free plans.** The Supabase free plan pauses an inactive project and offers no automatic backups (per Supabase's published plan terms;
  confirm current terms). A paying customer's finance records cannot live on that. The Pro plan is needed before the first customer.
  The database also grows quickly: one 10,000-ticket raffle is about 4 MB of tickets (**checked**), so the free 500 MB would hold only a
  few customers' worth.
- **No staging database.** Preview deployments use the live database (**checked**; every test I have run wrote to it and cleaned up).
  Fine for one customer; not acceptable once customers are paying.
- **No monitoring.** Nothing tells you when an action fails, a payment webhook is missed or the site is down.
- **No tested restore plan.**
- **Deploying** works by a commit-message word to save Netlify credits; fine for now, not a release process.

### 3.8 Code and testing
- `api.js` is 3,684 lines and `index.html` 3,351, each in one file. Workable, but every new feature is harder to change safely.
- Automated tests exist only for the gateway, the payment-release fix and the books check, run against a stand-in database. Older
  features were tested by hand against the live preview.
- The repository had **14 migrations fewer than the live database** until I found it on 2026-10-23: changes were applied through the
  Supabase tool without being saved as files. The database is currently the only complete record of its own structure.
- **Fix (Step 1):** save the full live structure as a baseline migration, then only ever change the database through saved migrations.

### 3.9 One decision that changes everything: shared or separate installs
Earlier (11 Oct, for Hall Booking) we decided on **one separate installation per customer** (own database, site and payment account).
Parish Campaigns was built the other way: **one shared system with an Organisation layer.** They cannot both be right.

| | Shared system (recommended) | Separate install per customer |
|---|---|---|
| Cost per customer | Almost nothing extra | A paid database + site each (about £30+/month), which swallows a small parish's fee |
| Isolation | Must be proven by tests and enforced in the database | Absolute |
| Updating everyone | One release | N releases |
| Fit | Parishes, schools, charities | A university or diocese that insists |

Recommendation: **shared system for everyone, with a dedicated install offered at a premium** to a customer who requires it. This is the
model the gateway specification already assumes.

## 4. Proposed order of work

Each step ships on its own, behind the existing "preview first, publish only when you say so" rule.

1. **Prove the walls and make the platform safe to build on.** Cross-customer test sweep of every action; baseline migration so the
   repository is the truth; a separate staging database so tests and previews stop touching live data; monitoring and a backup/restore
   plan; move to paid Supabase and Netlify plans when the first outside customer is agreed.
2. **Money per organisation.** Own payment account per customer, encrypted key, payment routing, currency.
3. **Settings and wording per organisation.** Country, currency, time zone, retention, feature switches (raffles off by default),
   wording per kind of institution, logo and colours, no St.Vincent's text left in the code.
4. **Proper accounts.** Email sign-in, reset by email, two-step for money roles, activity log, your own recovery path.
5. **Sign-up and billing.** Setup wizard, trial, plans and limits, subscription billing, suspend/export/delete.
6. **Then:** custom domains, sending email (receipts and confirmations), donations and Gift Aid, other languages, moving the function
   region, splitting the big files.

In parallel, and not code: trademark and domain search for the name, standard terms + processor agreement + sub-processor list, a first
price list, and two or three friendly pilot customers (a second parish and one school) to expose what we cannot see from here.
