# Parish Gateway — Build Specification
**v1.1** — for Claude Code, in the Parish Campaigns repo. Put this file at `docs/parish-gateway-spec-v1.1.md` and the prototype at `docs/prototype/parish-gateway-v1.9.html`.

**To start:** tell Claude Code: *"Read docs/parish-gateway-spec-v1.1.md and follow it. Work on the `dev` branch. Do Phase 1 only, and stop at the checkpoints."*

---

## 0. What this is

A single public page per organisation, reached by one short link (the owner's Bitly link and QR code). It is the front door to everything the organisation offers:

1. Three **permanent links** (for St Vincent's: Book the Parish Hall, Request a Mass Intention, Parish Newsletter).
2. **Get Involved** and **Registrations**: live lists that fill themselves from Parish Campaigns, plus items added by hand.
3. A **Notices bar** for an optional timed announcement (and an optional "today" line).

It is built into this app (same site, same database, same login), not as a separate product. It is later sold to other institutions (churches, schools, universities) as a configurable package.

The visual and behavioural source of truth is the prototype, `docs/prototype/parish-gateway-v1.9.html`. Open it in a browser (use the "Admin: Parish Page" tab to see the admin side). Where this spec and the prototype disagree, this spec wins. The prototype's placeholders (the "Today in the Church" saint text, the Add to Home Screen button, the parish name, address, email and phone) are not real content; see §8.

---

## 1. Hard rules (read before anything else)

**Do not affect any existing organisation. St. Vincent De Paul is live.**

1. **Additive only.** New tables, new columns that are nullable or have a default that preserves today's behaviour, new API actions, new files. No existing column, constraint behaviour, query result, page or URL changes.
2. **Off by default.** Every organisation gets `gateway_enabled = false`. Nothing is public until an admin turns it on. Existing `buy.html`, `register.html`, `registration.html` and their `?campaign_id=` links keep working unchanged.
3. **Campaigns are never listed by default.** `campaigns.listed_on_gateway` defaults to `false`.
4. **Do not edit existing files' behaviour.** In particular: do not change `public/sw.js`, `public/theme.css` or `ukToday()`. The gateway has its own service worker (§6.5), its own stylesheet and its own timezone helper. Branding of the existing buy/register pages is out of scope (§10).
5. **Migrations are safe to run on a live database.** Each is idempotent (`if not exists`), adds nothing that rewrites a large table, and is applied to a Supabase branch or dev project first, never first to production.
6. **Follow the project's own conventions.** Read `README.md`, `docs/scope-v1.0.md`, the migrations and the router in `netlify/functions/api.js` first. Reuse: `httpError`, `requireCampaignManager`-style org checks, `rateHit`, the actions map and the `READ_ONLY_PUBLIC` set, `campaignOpenState`, `onlinePlacesLeft`, `registrationPlacesLeft`. All data access goes through the one function with the service-role key. RLS stays locked, with no direct browser access.
7. **Production deploys cost credits.** Work on `dev`. Never put `PUBLISH-NOW` in a commit message unless the owner asks.
8. **No personal data on the gateway.** It shows campaign names, dates, places left, and organisation details only. Never names, answers, payments or contact details from registrations, tickets or payments.
9. **Verify before assuming.** Where this spec says "verify", read the actual schema or code, and if it differs from what is written here, stop and ask.

---

## 2. Decisions already made (do not reopen)

| Topic | Decision |
|---|---|
| Section names | **Get Involved** (non-registration campaigns and manual items) and **Registrations** (`campaigns.kind = 'registration'` and manual items in that category). Two categories only. |
| Order | Automatic by closing date (soonest first). An admin can re-order **within a section** by dragging, or with Up / Down buttons. Any manual re-order switches that section to "Custom order", with a "Back to automatic" button. Re-ordering never moves an item between sections. |
| New manual item | Lands at the **top** of its section when the section is in custom order. In automatic order it sorts by date. |
| Manual items | Fields: label, category, start date, **end date (required)**, web address (https only), optional button words. No description line. |
| Campaign items | Name and dates are edited in Campaigns only. On the gateway admin they can be switched on or off ("On the page") and re-ordered. |
| Cards | Two lines. Line 1: name (left), a standard-size button (right). Line 2: status in one line, such as "Closes in 9 days", "Closes 13 Nov · 12 left", "Full". "New" only if room. No description. All buttons the same size. |
| Full registrations | Show "Full". If the campaign has a waiting list, the button reads "Join waiting list". |
| Raffles | Never show tickets sold or any sales progress. |
| Notices bar | One slim bar under the masthead. Opens a panel. An **urgent** announcement puts its message in the bar itself (two lines at most). Urgent cannot be closed away. |
| Announcement | Message (max 200 chars), optional https link, start and end date-time in the organisation's timezone, urgent flag. Shown only between start and end, appearing and ending without anyone touching it. Warn (do not block) when there is no end. Refuse an end before the start. |
| Permanent links | Exactly three in v1: order fixed; label, one line and https address editable by an admin. Bad addresses are refused and the page keeps the last good one. |
| Campaign list size (new) | Show at most **three** cards per section, then a button **"See all (n)"** that reveals the rest in place. |
| Email | Not a line of its own in the masthead. A small **"Email us"** chip on the name row (right of the name) copies the address and confirms. The full address is also in the footer. |
| Next Mass | **Not in v1.** Mass times are configured on the Mass Intentions page in the separate Hall Booking build, which this app cannot read. The "Request a Mass Intention" button leads there. Do not add a Mass-times setting to this app (no duplicate entry). |
| QR code and short link | Outside the app. The owner makes the QR code and a Bitly link that points to `/go/<slug>`. Bitly can be re-pointed, so a slug change is recoverable. |
| Save to phone | Card near the end of the page ("Keep this on your phone"), with platform-specific steps (iPhone, Android, computer), Copy link, and "Done, don't show again". Hidden when opened from the home screen. |
| Readability | Base text 17px and nothing below 15px; tap targets 44px or more; high contrast; all sizes in `rem`; both light and dark themes. |

---

## 3. Data model (new migration files)

Name them in the project's style, for example `supabase/migrations/2026MMDD000000_gateway.sql`. **Verify** the existing columns on `organizations` and `campaigns` first, then adapt. Draft:

```sql
-- Organisation: addressing, tenant settings, branding (all additive)
alter table organizations
  add column if not exists slug text,                         -- public address /go/<slug>; unique when set
  add column if not exists gateway_enabled boolean not null default false,
  add column if not exists timezone text not null default 'Europe/London',
  add column if not exists vertical text not null default 'church'
    check (vertical in ('church','school','university','generic')),
  add column if not exists display_name text,                 -- shown in masthead; falls back to name
  add column if not exists brand_core text                    -- '#rrggbb', null = default palette
    check (brand_core is null or brand_core ~ '^#[0-9a-fA-F]{6}$'),
  add column if not exists brand_logo text;                   -- data: URI, size-limited by the API
create unique index if not exists organizations_slug_idx on organizations (lower(slug)) where slug is not null;

-- Campaigns: opt in to the gateway (never listed by default)
alter table campaigns
  add column if not exists listed_on_gateway boolean not null default false,
  add column if not exists gateway_cta text;                  -- optional button words

-- The three permanent links
create table if not exists gateway_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  position int not null check (position between 1 and 3),
  icon text not null default 'link',
  label text not null, sub text not null default '', url text not null,
  updated_by uuid references users(id), updated_at timestamptz not null default now(),
  unique (org_id, position)
);

-- Announcement (history is kept, newest wins)
create table if not exists gateway_announcements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  message text not null check (char_length(message) <= 200),
  link_url text, urgent boolean not null default false,
  starts_at timestamptz not null default now(), ends_at timestamptz,
  created_by uuid references users(id), created_at timestamptz not null default now(),
  check (ends_at is null or ends_at > starts_at)
);
create index if not exists gateway_announcements_org_idx on gateway_announcements (org_id, starts_at desc);

-- Items added by hand (not from Campaigns)
create table if not exists gateway_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  section text not null check (section in ('involved','registration')),
  label text not null, url text not null, cta text,
  starts_on date not null, ends_on date not null,             -- end required
  listed boolean not null default true,
  created_by uuid references users(id), created_at timestamptz not null default now(),
  check (ends_on >= starts_on)
);

-- Custom order per section; absent row = automatic order
create table if not exists gateway_order (
  org_id uuid not null references organizations(id) on delete cascade,
  section text not null check (section in ('involved','registration')),
  item_ids text[] not null,                                   -- campaign ids or gateway_item ids, in order
  updated_at timestamptz not null default now(),
  primary key (org_id, section)
);

-- Optional hand-kept "today" line (e.g. saint of the day). No external source in v1.
create table if not exists gateway_daily (
  org_id uuid not null references organizations(id) on delete cascade,
  on_date date not null, title text not null, blurb text,
  primary key (org_id, on_date)
);

alter table gateway_links enable row level security;
alter table gateway_announcements enable row level security;
alter table gateway_items enable row level security;
alter table gateway_order enable row level security;
alter table gateway_daily enable row level security;
-- no policies: only the server (service role) reads or writes, as everywhere else in this project
```

Notes:
- `brand_logo` as a `data:` URI follows the project's existing rule that uploaded files live in the database. Enforce a size limit in the API (200 KB) and PNG, JPEG, WebP or SVG only (§6.6).
- Retention: none of these tables hold personal data, so the nightly retention job does not touch them. State that in a comment.
- Seed: for St. Vincent De Paul, set `slug` and the three permanent links (no Mass times) but leave `gateway_enabled = false`. The owner switches it on.

---

## 4. API (in `netlify/functions/api.js`, following its existing patterns)

### 4.1 Public, read-only: `public_gateway`
- Input: `{ slug }` only. **Never accept an organisation id from the client.** Resolve `slug → organisation`; if missing or `gateway_enabled = false`, return a plain 404 ("This page is not available").
- Rate limit with the existing `rateHit` helper. Add the action to `READ_ONLY_PUBLIC` if that is what the set is for (verify).
- Returns **named fields only**, never whole rows:
  - `org`: `{ name (display_name or name), address, contact_email, timezone, vertical, brand: { core, logo } }`
  - `links[]`: `{ icon, label, sub, url }` in position order
  - `announcement`: the single newest announcement where `starts_at <= now() < coalesce(ends_at, infinity)`, else `null`. Fields: `{ message, link_url, urgent, ends_at }`
  - `daily`: `{ title, blurb }` for today in the org's timezone, else `null`
  - `sections.involved[]` and `sections.registration[]`, already ordered, each item `{ id, source: 'campaign'|'manual', name, closes_on, opens_on, places_left (or null), full (bool), waiting_list (bool), cta, href }`
    - Campaign items: `listed_on_gateway = true`, not binned, not draft, active, `public_page_enabled = true`, and `campaignOpenState(c) === 'open'` (computed with the org's timezone, see §6.3). Section from `kind`. `href` = the existing public page (`/buy.html?campaign_id=…` or `/register.html?campaign_id=…`; verify the real paths). Places left from `onlinePlacesLeft` or `registrationPlacesLeft`; waiting-list state from the existing campaign flag. **For raffles, `places_left` is always `null`.**
    - Manual items: `listed`, and today between `starts_on` and `ends_on`. `href` = the stored URL.
    - Order: the stored `gateway_order` for that section if present (ids not in it go to the end; ids no longer live are dropped), otherwise `closes_on` ascending.
- Response headers: `Cache-Control: public, max-age=60, stale-while-revalidate=300`. No cookies. No personal data.

### 4.2 Admin actions (organisation-scoped session; every query filters on `session.org_id`)
Follow the existing role checks. Allowed: `superadmin` and `admin` of that organisation. (A limited "Office" role is Phase 3, §9.) Platform Owner can act on any organisation for onboarding.

| Action | Purpose |
|---|---|
| `gateway_get` | Everything the admin screen needs: settings, links, current and recent announcements, all campaigns (listed or not, with their state) and manual items, ordered as stored, plus each section's mode (`automatic` / `custom`). |
| `gateway_save_links` | Update label, sub and url for positions 1 to 3. |
| `gateway_save_announcement` / `gateway_clear_announcement` | Create (a new row; the newest wins) or end the current one (sets `ends_at = now()`). |
| `gateway_item_save` / `gateway_item_delete` | Manual items. |
| `gateway_set_order` | Store a section's order, or clear it to return to automatic. |
| `campaign_set_listed` | Set `listed_on_gateway` for a campaign the caller can manage (reuse `requireCampaignManager`). |
| `gateway_set_enabled` | Turn the page on or off. |
| `org_set_brand` | Set `brand_core`, `brand_logo`, `display_name`, `slug`, `vertical`, `timezone`. Slug changes need confirmation because the owner's Bitly link must be re-pointed. |

### 4.3 Server-side validation (the browser is never trusted)
- URLs: must match `^https://` followed by a real host with a dot, no spaces, max 2,000 characters. Reject `javascript:`, `data:`, `mailto:` and anything else. Show the same rule in the admin as a message.
- Text: strip control characters, enforce lengths (label 60, sub 60, cta 24, message 200). Store plain text. The page must always render text with `textContent` or an escape function, never as HTML.
- Dates: manual item end required and not before the start; announcement end after start.
- Slug: lowercase letters, digits and hyphens, 3 to 40 characters, not on a reserved list (`api`, `admin`, `go`, `assets`, `fonts`).
- Audit: record who changed what (the `updated_by` / `created_by` columns above).

---

## 5. Admin screen ("Parish Page" tab in the existing app)

Add one tab to the existing admin app. Follow the existing app's look, but implement the behaviour shown in the prototype's **Admin: Parish Page** tab:

1. **Permanent links** (3 rows): title, one line, web address with live validation ("Saved" or the error).
2. **Announcement**: message (with 200-character counter), quick wording buttons, optional link, shows-from and hides-at, urgent switch, status pill (Off / Scheduled / Live now / Ended), and the warnings listed in §2. Quick wording buttons for a church: "Mass cancelled", "Funeral arrangements", "Office closed".
3. **What's on the page**: "Add something" form (label, category, starts, ends, address, button words) with the live checks in the prototype (including the warning "This looks like a Parish Campaigns page. List it from Campaigns instead"). Two groups, **Get Involved** and **Registrations**, each showing its mode ("Automatic order: closing soonest" or "Custom order" with "Back to automatic"). Each row: drag handle, name, tag "From Campaigns" or "Added here", dates and live status, an "On the page" switch, **Up / Down** buttons, and Edit / Remove (two-tap) for manual items only.
4. A **"See the public page"** button that opens `/go/<slug>`.

Editing a campaign's name or dates still happens in the existing Campaigns screens, never here.

---

## 6. Public page

### 6.1 Route and files
- `public/go.html`: one static shell. Add a rewrite in `netlify.toml`: `/go/*` → `/go.html` (status 200), placed so it does not touch `/api/*`.
- The shell reads the slug from `location.pathname`, calls `public_gateway`, and renders. It uses the project's own self-hosted fonts and no outside requests (the CSP is `connect-src 'self'`).
- Port the prototype's markup, behaviour and interaction as-is, with these changes: the two items in §2 marked "(new)", and the styles expressed as CSS variables (§6.6).

### 6.2 Layout (top to bottom)
Masthead (logo or cross, name, and the "Email us" chip on the same row) → Notices bar → three permanent-link buttons (the hero) → **Get Involved** (≤3 cards, then "See all (n)") → **Registrations** (same) → "Keep this on your phone" card → organisation details (name, address, office hours, phone) → footer. A section with nothing live hides itself. If both are empty, show "Nothing is open right now. Please check back soon, or ask at the parish office."

### 6.3 Dates and time
All "open now", "closes in N days" and announcement windows use the **organisation's timezone** (`organizations.timezone`). Write a small helper (for example `todayIn(tz)`) for the gateway only. Do not change `ukToday()` (existing behaviour must not move). Status wording: "Closes today", "Closes tomorrow", "Closes in N days" when 14 or fewer, otherwise "Closes 13 Nov". Warning colour when 7 days or fewer, or places 25% or fewer.

### 6.4 Next Mass (not in v1)
No "Next Mass" line. Mass times live in the Hall Booking build and are shown on the Mass Intentions page that the second permanent button opens. Revisit only if that build offers a read-only list of times (see §8).

### 6.5 Offline and install
- A **separate** service worker at `public/go/sw.js`, registered from `go.html` with scope `/go/`. It stores the last good page and the last good `public_gateway` response, uses network-first with a short timeout, and falls back to the saved copy offline. When showing a saved copy it makes no claims about being current. It never touches `/api` mutations.
- A web app manifest per organisation is **not** in Phase 1. The Add to Home Screen card shows the platform steps and a Copy link button only (the browser's install prompt is used only if the browser offers it).

### 6.6 Branding and theme
- The page's colours are CSS variables: `--brand`, `--brand-text`, `--brand-tint`, plus neutrals and warning colours, as in the prototype. Defaults are the prototype's palette.
- If `brand_core` is set, the server (or the shell) derives the rest from that one colour:
  - `--brand` = the core colour, adjusted only if white text on it fails contrast 4.5:1 (darken until it passes).
  - `--brand-text` = a version that reads at 4.5:1 on the page surface in both light and dark themes.
  - `--brand-tint` = about 12% of the colour mixed into the surface.
  - Dark theme versions derived the same way.
- On save, tell the admin what happened: for example "We darkened your colour slightly so white text is easy to read." Never silently accept a failing pair.
- Logo: PNG, JPEG, WebP or SVG up to 200 KB. For SVG, strip scripts and external references before storing (or reject SVG in Phase 1 if that is simpler to do safely). It replaces the cross in the masthead; alt text is the organisation's name. Offer to suggest a core colour from the logo.
- Typography: no free font choice. Use the project's self-hosted fonts; a small set of approved pairings may come later.

---

## 7. Making it reusable (small, now, so it never needs a rewrite)

- **Vertical preset** (`church | school | university | generic`) selects defaults only, in code: section titles, suggested link labels, quick-wording buttons, and whether the daily line is offered. Everything is overridable per organisation. Phase 1 needs `church` and `generic` only, but keep the structure.
- Keep all visitor-facing wording in one object per vertical, not scattered through the code. Avoid church words anywhere else in code and database names.
- No customer-specific branches, files or `if (org === …)`.

---

## 8. Open items (ask the owner, do not decide alone)

1. **"Today in the Church"** is not built from an external source. Phase 1 shows `gateway_daily` if a row exists for today, otherwise nothing. The owner is still deciding on a source (Westminster Diocese feed, an open liturgical-calendar API, or a hand-kept list).
2. **Who may edit the page:** SuperAdmin and Admin in Phase 1. A limited "Office" role needs a change to the allowed values on `users.role`. That is additive, but confirm with the owner first.
3. **Custom domains** and **branding the existing buy and register pages** are out of scope (§10).
4. **Next Mass** returns only if the Hall Booking build exposes Mass times read-only (an endpoint, or a database both apps can read). Ask the owner before building anything for it.

---

## 9. Phases and checkpoints

**Phase 1: St. Vincent's, off by default (do this now)**
1. Read the repo, then write the migration and apply it to a Supabase branch or dev project. **Checkpoint 1:** show the migration, the list of existing objects it touches (it should be none beyond adding columns), and confirm existing pages still work.
2. `public_gateway` and the admin actions, with server-side validation.
3. `go.html`, `go/sw.js` and the `netlify.toml` rewrite.
4. The admin tab.
5. Tests (§11). **Checkpoint 2:** show test results and a screenshot of `/go/<slug>` on a 390px and a 360px wide viewport, light and dark.
6. Stop. The owner reviews on the dev deploy preview, then decides about production and about switching `gateway_enabled` on.

**Phase 2: branding and a second organisation**
`org_set_brand`, the colour derivation and contrast guard, logo upload, a platform-owner onboarding screen, and a pilot with a non-church organisation to expose hidden assumptions.

**Phase 3: packaging**
Custom domains (`host → organisation` lookup), the "Office" role, plans and billing.

---

## 10. Out of scope for Phase 1

A "Next Mass" line or any Mass-times setting; QR codes and posters (the owner uses Bitly); branding or restyling `buy.html`, `register.html`, `registration.html` or the admin app; changes to `sw.js` or `theme.css`; a web app manifest; external calendar feeds; analytics or tap counts; multiple languages; scan-source tags; custom domains; billing.

---

## 11. Acceptance tests (all must pass before checkpoint 2)

**Safety for existing parishes**
- With `gateway_enabled = false`, `public_gateway` returns 404 for St. Vincent De Paul, and nothing else in the app behaves differently.
- A before-and-after run of the existing flows (create a campaign, sell a ticket, a registration, a waiting list, the nightly retention function) gives identical results.
- No existing file's behaviour is changed (`git diff` shows additions only to `api.js`, plus the new files and `netlify.toml` rewrite).
- Migrations run twice without error.

**Tenant isolation**
- Two test organisations: organisation A's admin can never read or change organisation B's links, announcements, items or order. `public_gateway` for slug A never contains anything of B.
- The public response never includes an organisation id, user, payment, ticket or registration detail, and never includes raffle sales figures.

**Behaviour**
- A campaign appears only when listed, active, not draft or binned, and between its opening and closing dates in the org's timezone, and disappears the day after it closes.
- A manual item appears from its start date and disappears after its end date. Saving without an end date fails.
- An announcement appears at its start time and disappears at its end time without anyone saving anything. Urgent shows in the bar. Overlapping announcements: the newest wins.
- Custom order persists per section; an expired item drops out while the rest keep their order; "Back to automatic" restores closing-date order; a new manual item lands at the top of a custom order.
- Full registration shows "Full"; with a waiting list it shows "Join waiting list".
- More than three items in a section show three and "See all (n)".

**Security**
- URLs with `javascript:`, `data:`, `mailto:`, `http:` or spaces are refused server-side. Text containing `<script>` is displayed as text.
- Excess requests to `public_gateway` are rate limited.

**Presentation**
- No horizontal scroll at 360px. Smallest text is 15px or larger; tap targets are 44px or larger; light and dark both readable.
- The page opens with no signal after one earlier visit, showing the saved copy.

---

## 12. Version history

- **v1.0** — first specification, from prototype v1.8 plus the "three cards then See all" and "Email us chip" changes.
- **v1.1** — Next Mass removed from v1 (times live in the separate Hall Booking build). "Email us" chip moves to the name row. QR codes and posters are out of scope (Bitly). Prototype reference is now v1.9.
