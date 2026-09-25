# Parish Campaigns Platform — Scope Document
**v1.0** — living document, source of truth for the generalized rebuild

---

## 1. Objective

Generalize the BBQ ticketing system (live, tested, working at St. Vincent De Paul
Church, Osterley) into a single reusable platform that can run **any** unit-based
campaign — BBQ tickets, Christmas dinner places, raffle entries, or anything
else sold in discrete units with a name and a price — while carrying forward
every UX and reconciliation lesson learned building the BBQ version, not
rebuilding from scratch.

Built going forward in **Claude Code**, on a proper GitHub repo, so the project
is never again dependent on a single chat session's memory or an uploaded zip.

---

## 2. Non-negotiable: what we already learned, and must not lose

These are hard-won, tested in a live event, not theoretical. The rebuild must
preserve every one of these, not "improve" them away:

1. **Near-zero typing for sellers.** Enter counts + one starting number; the
   rest of the ticket numbers fill in automatically, editable if the physical
   batch isn't consecutive.
2. **A unit handed over is handed over.** Once a card sale is initiated, it
   never silently auto-releases (no timeout-based release). Only a deliberate
   Admin action (Void) frees it back up. This matches physical reality — the
   buyer already has the ticket in hand.
3. **Cash needs a deliberate reconciliation step**, not just a running total —
   oldest-first lump-sum matching against what a seller actually hands over,
   correctly distinguishing a genuine shortfall (money doesn't even cover the
   oldest pending sale) from a genuine surplus (everything's matched, there's
   extra) — these are NOT the same thing and must never be conflated in the UI.
4. **SumUp's API will fail sometimes** (auth/scope issues are real and have
   already happened). The manual "log it yourself" path (cash-register-style:
   payment taken elsewhere, seller logs ticket + buyer name in the app) is a
   **first-class, permanent path**, not a temporary fallback — even once SumUp
   API integration works.
5. **A single reusable/dynamic SumUp Payment Link QR works fine** and needs no
   per-sale API call — shown to the buyer, they pay, seller logs it the same
   way as a reader payment. **Extended 2026-09-13:** the same link can also be
   sent directly by SMS, WhatsApp, or Email instead of only shown as a QR on
   the seller's screen — the buyer pays in their own time, and the seller
   moves straight on to the next sale without waiting. The sale is still
   logged the same way, once the seller sees the payment come through.
   **Corrected 2026-09-21:** the payment link (and its QR) belongs to each
   **campaign**, not to the parish as a whole — every campaign has its own.
   **Superseded 2026-09-21 by §9:** each sale now gets its own SumUp link (with the
   sale's id as its reference) instead of one fixed campaign link.
6. **Optional, non-blocking photo evidence** for manually-logged payments —
   never required, never blocks the next sale.
7. **Specific, accurate error messages.** "This ticket doesn't exist in this
   campaign" and "this ticket is already sold" are different problems and must
   never share one misleading message.
8. **Displayed data must match physical reality** — no invented letter
   prefixes or labels that don't appear on what the buyer is actually holding.
9. **Role must never hide a real transactor.** Anyone who can sell (Seller,
   Admin, SuperAdmin) must appear in every reconciliation screen — Cash Recon
   included. This bug already happened once and cost real confusion.
10. **GDPR-safe retention that respects real accounting needs** — personal
    identifiers (names) get anonymized after a policy window; financial
    totals/ticket numbers are retained, since churches need those for
    accounting/Charity Commission purposes regardless of GDPR minimization.
11. **Live, session-scoped conveniences**: a seller's last-used campaign is
    remembered for the length of their login session; sessions auto-expire
    (2 hours) both server- and client-side.
12. **Never lose in-progress seller entry.** Switching campaigns, viewing a QR,
    or any other in-screen action must never blow away a half-completed sale
    form — panels toggle visibility, they don't rebuild and reset state.

---

## 3. Open UX issue carried into this rebuild — needs a decision

**The cash/card mis-tap problem.** Sellers have hit "Cash" when they meant
"Card" (and vice versa) in real live use. Current fix is Void + re-enter,
which works but is heavier than it should be for a simple mis-tap.

**Proposed fix**: a short, no-questions-asked **"Undo"** affordance immediately
after logging a sale (a few seconds' window, single tap, no reason required)
for genuine slip-of-the-thumb corrections — with the existing Void-with-reason
flow remaining the audit-trail mechanism for anything after that window closes
or for a sale that's already been acted on (e.g. cash already reconciled).

**Decided (2026-09-12): confirmed as proposed.** Timed Undo for the first few
seconds after logging a sale; Void-with-reason remains the mechanism once that
window closes or the sale has been touched by reconciliation.

---

## 4. Data model — the generalization

### 4.1 New top layer: Organization

Even though only one parish exists today, the data model must assume a second
one is coming, because retrofitting this later (once real data exists) is far
more painful than designing for it now.

- **Organization** (e.g. "St. Vincent De Paul Church, Osterley") — the tenant.
  Every Campaign, User, and downstream record belongs to exactly one
  Organization. SuperAdmins are scoped to their Organization, not global,
  from day one — even with only one Organization actually in use.

**Decided (2026-09-12): build the Organization layer now**, before any second
parish exists, per the reasoning above.

**Decided (2026-09-13): a global Platform Owner role sits above per-Organization
SuperAdmin.** Clarifying the role hierarchy raised while reviewing the
prototype:

- **Platform Owner** — global, not scoped to any Organization. Creates new
  Organizations (onboarding a second parish) and that Organization's first
  Admin/SuperAdmin. This is Justin's own role as the platform's operator, not
  a per-parish role.
- **SuperAdmin** — scoped to one Organization (unchanged from §4.1's original
  decision). Top of that parish's own hierarchy; creates Admins and Sellers
  within it.
- **Admin** and **Seller** — scoped to one Organization, structurally
  unchanged from the live BBQ build.

This supersedes the live app's current "First-time SuperAdmin Setup" flow
(self-service, works once, only before any users exist at all) — that model
doesn't extend to "onboard parish #2" without a Platform Owner explicitly
creating it, so that bootstrap flow needs redesigning as part of the build,
not carried over as-is.

### 4.2 Generalized Campaign

Replaces the BBQ-specific model. A Campaign now defines:
- Name, active/inactive/binned state (unchanged from today)
- **A flexible list of price tiers** — any number, each with its own name and
  price (e.g. `Adult £12 / Child £5` for BBQ, `Ticket £3` for a single-tier
  raffle, `Adult £15 / Child £8 / Vegetarian £15` for a Christmas dinner).
  This replaces the hardcoded two-tier Adult/Child model entirely.
- One or more **ticket number blocks** (already decided: disjoint blocks
  supported, e.g. a top-up batch added later under the same campaign)
- The word **"Ticket"** stays as the universal term throughout the UI,
  regardless of what's actually being sold (confirmed — no per-campaign
  relabeling of the unit itself)

**Decided (2026-09-12) on tier generality**: the core principle is a ticket may
carry **variables that affect price** (e.g. Adult vs Child), not a fixed set of
named categories. So a tier is really "a named variant with its own price" —
already what section 4.2 describes — and that's confirmed general enough to
cover BBQ, Christmas dinner, raffle, and future campaigns without further
special-casing. No structural change needed; this confirms the existing tier
design rather than extending it.

### 4.3 Tickets, Payments, Users

Structurally unchanged from the BBQ build — ticket claiming, payment records,
buyer name, seller attribution, cash recon, void/audit trail all carry over
as-is. The only change is that a ticket's "tier" is now a foreign key into a
campaign's own tier list, instead of a hardcoded `A`/`C` enum.

### 4.4 SumUp integration, fully generalized

Once the API key/scope issue is resolved:
- Automated checkout creation ties a SumUp transaction directly to the
  specific ticket(s)/tier(s) sold, same reconciliation depth as originally
  designed for BBQ (transaction code capture, resend-on-failure, Needs
  Attention queue) — but now working for any campaign's tiers, not just
  Adult/Child.
- Manual logging (Cash, Card-on-reader/link) remains fully supported
  alongside it, permanently (see Learning #4).

**Decided (2026-09-12): build proceeds now on manual-only** (Cash, Card-manual)
without waiting for the SumUp API auth/scope issue to be resolved. Automated
SumUp checkout creation (this section) is wired in later as a drop-in once
API access is sorted — it does not gate the rest of the build.

---

## 5. Build phases (per our standard method)

1. **Scope** — this document; review and mark up before anything is built
2. **Prototype-first** — a clickable, design-led prototype of the generalized
   Sell screen (flexible tiers instead of Adult/Child) and campaign
   configuration screen, validated before any backend work
3. **Consolidate** — fold prototype feedback back into this document as the
   single source of truth
4. **Build in phases**: data/foundation (Organization + generalized schema) →
   subsystems (tiers, SumUp integration, recon) → wire validated front-ends →
   end-to-end dry-run across every user type and edge case → handover
5. **Migration**: the live BBQ data (Organization = Osterley, BBQ26 as a
   Campaign with an Adult/Child tier pair) migrates into the new model as the
   first real Organization/Campaign — nothing about the live event data is
   lost or re-entered

---

## 6. Claude Code transition

1. Create the GitHub repo (not yet done) and push the current working BBQ
   codebase as the starting commit — this becomes real, persistent history
2. Move active development into Claude Code, working directly against that
   repo — no more zip-file handoffs, no more sandbox-reset risk
3. Client ownership from day one carries forward unchanged: Justin's own
   repo, own Supabase project, own Netlify site, own SumUp account — nothing
   here becomes a dependency on any one tool session

---

## 7. Open questions for Justin — resolved 2026-09-12

- [x] Cash/card mis-tap fix: **timed Undo**, Void-with-reason remains the
      fallback after the window closes or reconciliation has touched the sale
      (Section 3)
- [x] Organization layer: **build it now**, before a second parish exists
      (Section 4.1)
- [x] Other unit types: tier model is confirmed general enough as designed —
      a tier is a named price variable (e.g. Adult/Child), not a fixed
      category list (Section 4.2)
- [x] SumUp timeline: **proceed with Cash/Card-manual now**; automated SumUp
      checkout is a later drop-in once the API access issue is resolved
      (Section 4.4)

---

## 8. Physical, digital, or hybrid ticketing — resolved 2026-09-13

**Digital tickets, no physical stock.** Raised by Justin against the prototype's
Sell screen: some campaigns may have no printed ticket book at all — a fully
digital ticket, shared straight from the seller's phone via its native share
sheet (Messages/WhatsApp/Mail/etc., whichever the seller picks — there is no
way to auto-target one specific channel or contact) instead of handed over as
paper.

This is not just a UI addition. Today's model assumes every campaign has a
pre-printed, numbered physical ticket block — that assumption underpins
Non-negotiable #1 (near-zero typing against a known range) and Non-negotiable
#8 (displayed data must match physical reality). A fully digital campaign
wouldn't need a pre-printed number range at all; the ticket number could be
generated at the moment of sale instead. Physical and digital ticketing could
plausibly coexist per-campaign, but that's a data-model fork, not a button
added to the existing Sell screen.

**Decided (2026-09-13): it's a per-campaign choice, made at the ticket-block
level, and hybrid is explicitly supported.** A campaign's existing "one or
more ticket blocks" (§4.2) now each carry a type, Physical or Digital:

- A **physical** block behaves exactly as today — a pre-declared numbered
  range, near-zero-typing entry, live "doesn't exist" / "already sold"
  checks.
- A **digital** block has no pre-declared range — its ticket numbers are
  assigned automatically at the moment of sale, so there's nothing to type
  and nothing to check.
- A campaign can have **only physical blocks, only a digital block, or
  both** (a genuine hybrid — e.g. a printed ticket book alongside an online
  sales channel for the same campaign). There is no separate "hybrid" setting
  to pick — a campaign is hybrid simply by having more than one block with
  different types, same as it already supports multiple physical blocks
  (e.g. a top-up) today.

This reframes Non-negotiable #8 (displayed data must match physical reality)
for the digital case: the ticket identifier shown to the seller and the one
sent to the buyer must always match exactly — there's no "physical" to check
against, so that consistency is the digital equivalent of the same rule.

**Refined 2026-09-13, from prototype review:**

- **A digital block is entirely self-generating.** Creating one takes no
  manual entry at all beyond choosing "Digital" — no label, no numbers. It
  names and numbers itself (e.g. "Online", "Online 2" for a second one in the
  same campaign). This is deliberately different from a physical block, which
  still requires a start/end range to be entered — that range is what makes
  the live "doesn't exist" / "already sold" checks possible.
- **Share applies to any sold ticket, not just digital ones.** Every
  finalized sale — physical or digital, cash or card — gets a "Share ticket"
  action, e.g. a seller who forgot to hand over a receipt, or wants to send
  a digital copy alongside a physical ticket. Rather than only the OS's
  generic share sheet, it presents an explicit choice of **SMS / WhatsApp /
  Email**, each opening the seller's own default app for that channel
  (`sms:`, `wa.me`, `mailto:` handoff — still no way to auto-target one
  specific contact; the seller picks who). The message includes: campaign
  name, ticket count and tier breakdown (e.g. "2 x Adult, 1 x Child"), the
  ticket number(s), the amount, and the date/time of sale.

---

## 9. Payment modes and Pay by Link — decided 2026-09-21

**Physical tickets are paid three ways:**

1. **Cash** — logged by the seller, reconciled oldest-first as before.
2. **Pay at Machine** — the buyer taps on the POS machine outside the church; the seller
   logs it (optional photo evidence, as before).
3. **Pay by Link** — a SumUp payment link is generated **for that sale** (not a shared
   campaign link) and sent to the buyer from the seller's own SMS / WhatsApp / Email.

**Pay by Link must let us pinpoint who has a physical ticket and whether they've paid.**
For every link sale we record: the ticket numbers handed over, the buyer's name, the
**mobile or email the link was addressed to**, the **channel it was sent by** and **when**,
and SumUp's reference. The SumUp `checkout_reference` is the sale's own id, so every payment
SumUp reports maps back to exactly those tickets and that buyer. SumUp notifies the app
(`/api/sumup_webhook`) when a checkout changes status; the app never trusts the notification
itself — it re-fetches the checkout from SumUp with its own key. The physical ticket stays
"held" (never resellable) until paid; unpaid links surface in **Needs Attention** with the
buyer's contact so they can be chased, or a fresh link issued.

Notes: the link's contact is personal data and is anonymized with the buyer's name after
the retention window. A link sale can't be self-Undone (the link already exists) — an Admin
Voids it; if such a sale is later paid anyway, the void is flagged loudly for a refund.
The reference is per sale (one payment can cover several tickets); each ticket row points
to its sale, so every ticket is traceable to its SumUp reference.

**Online-only campaigns** (e.g. an online raffle): tickets are digital, generated online, and
**can only be paid by Pay by Link** (enforced server-side). An unpaid online ticket is
removed when its link expires — nothing exists until it's paid.

*Open, to decide before building the buyer-facing side:* who starts an online purchase (a
seller sending a link, or the buyer on a public page), and how the buyer receives the ticket
after paying.

**Refined 2026-09-22:** the SumUp `checkout_reference` shown on each payment link is
cosmetic, not the mechanism — reconciliation always matches on SumUp's own internal
checkout id, never on this string. So it's formatted purely to be readable to Justin on
SumUp's own dashboard/exports: `<CAMPAIGN-SLUG>-<SHORT-ID>`, e.g. `RAFFLE2026-A1B2C3D4`,
letting a scan of SumUp's own transaction list show at a glance which campaign a payment
belongs to.

---

## 10. Online ticket series, lucky numbers, and seller vs. buyer-direct — decided 2026-09-22

**Online tickets now come from a real, declared series, exactly like physical.** Raised by
Justin: a defined range (e.g. "O15001 to O20000"), not an open-ended counter, so a specific
number can be checked and picked — a "lucky number" — the same way a physical ticket already
works. This replaced the original digital-block design (an auto-incrementing counter minting
numbers on the fly, nothing to check against): physical and digital blocks are now
structurally identical, both pre-populating every number in their declared range as
'unsold'. The only remaining differences are (a) an online block can only be paid by Pay by
Link — there's no cash or machine payment for something with no physical form — and (b) an
online block can carry an optional display prefix (e.g. "O"), shown before the raw number to
buyers. This is not an invented physical-reality mismatch (non-negotiable #8): for a ticket
with no separate physical object, whatever number the buyer is told IS what they're holding.

For an online series, a seller (or eventually a buyer) chooses between **"Pick a number"**
(a specific lucky number, live-checked) and **"Any available"** (the lowest-numbered unsold
tickets, claimed atomically — two simultaneous "any available" purchases can never collide).

**A paid ticket now sends the buyer an actual ticket, not just a payment link.** Once a Pay
by Link sale shows Paid, a "Share ticket" action appears (the same mechanism already built
for Cash/Machine sales), pre-filled with the buyer's own contact — campaign, tier breakdown,
ticket number(s), amount, and sale date/time. Justin is separately supplying the physical
ticket's exact layout so the message can mirror it.

**Both a seller-initiated sale and a buyer-direct purchase (no seller involved) need to be
supported.** The backend now supports either: a purchase always has a `seller_id`, but
whether that's a real staff member acting for someone, versus a future buyer-initiated flow,
is a distinction the data model needs to represent cleanly rather than forcing every online
sale through a person. This is not yet built — see the open item below.

**Decided (2026-09-22): ticket delivery is a confirmation page on the site itself** — after
paying, the buyer lands on a page showing their ticket, which they can screenshot or
bookmark. No SMS/email service, no new third-party account, no ongoing per-message cost.
`payments.seller_id` will become nullable to represent "no seller involved" cleanly. Until
the public buyer-facing purchase page itself is built, only the seller-initiated Sell screen
supports online tickets today.

---

## 11. Buyer confirmation experience — open, deferred by Justin on 2026-09-22

**Reminder: buyer-direct online purchases (§10's open item) are still not built.** Deferred
again this session — pick up next time.

**New requirement, recorded for when this is built:** the confirmation page — showing the
buyer their actual assigned ticket, with a Save button to keep the image on their phone —
must appear **after** payment succeeds, not before. Before payment, both flows only ever
promise an *assignment subject to payment*:

- **Seller-initiated:** the message sent already says (in effect) "Online Raffle number
  O15001, O15002 has been assigned to you, subject to payment" with the SumUp link — this
  part already works. What's missing: once that link is paid, the buyer should land on a
  confirmation page (their actual ticket, Save button) — not on raw API output.
- **Buyer-direct (not yet built):** the same shape — "Ticket O12345 has been assigned to you,
  subject to payment" with a link — buyer pays, then returns to see the same kind of
  confirmation page.

**Concrete bug found while recording this:** `createSumupCheckout`'s `return_url` currently
points straight at `/api/sumup_webhook`, which returns JSON — if that's genuinely what SumUp
redirects the buyer's own browser to after paying (rather than only a server-to-server
notification address), a real buyer would land on raw API output instead of a page. This
needs a dedicated user-facing confirmation page as its target, separate from the
server-to-server notification handling — to be fixed together with the confirmation page
itself, not before.

**Alternative/fallback Justin raised, worth keeping regardless of the above:** a
trust-based hold — assign the ticket immediately, with a stated deadline ("subject to
payment within 24 hours of assignment, after which it's released to anyone else"), showing
the actual date/time by which payment is due. Note this would need its own hold window for
online tickets specifically: today's `STALE_MINUTES = 35` (a SumUp hosted-checkout-validity
figure, not a considered buyer-facing grace period) applies uniformly to every link sale,
physical or online, and an online ticket is currently released as soon as SumUp reports the
link failed/expired — not held for a fixed communicated window. These two ideas (a proper
post-payment confirmation page, and a longer stated grace window before release) aren't
mutually exclusive and can both be built.

---

## 12. Cash/Machine allowed for online tickets too — decided 2026-09-22

**Reconsiders part of §10:** online tickets are no longer restricted to Pay by Link only.
The real distinction isn't "online vs. physical," it's **whether a seller is physically
present vouching for the sale, versus an unattended remote purchase**. When a seller is
standing with a buyer taking cash or a card tap on the machine, the trust model is identical
whether the ticket comes from the physical stack or the online series — there's no paper
ticket to hand over for an online one, but the seller can send the existing "Share ticket"
confirmation on the spot instead. Forcing Pay by Link in that moment (buyer's cash already
out, now wait for a text and a link) added friction without adding trust.

Pay-by-Link-only remains the right rule specifically for an **unattended** sale — a buyer on
a future public page, or paying in their own time from a link sent earlier — since nobody is
there in person to vouch for them. `record_sale` is only ever reachable by an authenticated
seller/admin/superadmin today, so this restriction was removed from it entirely; it belongs
on the future public buyer-direct endpoint instead, not on this one.

**Decided against:** flagging which online entries were electronically verified (via Link)
vs. seller-vouched (Cash/Machine) in reporting, for raffle-draw optics. Justin: seller
accountability (the buyer name required on every sale) is enough.

---

## 13. Three refinements to online tickets — decided 2026-09-22

1. **Picking a specific "lucky number" is reserved for the public buyer page.** A
   seller-initiated online sale (today's only working path) always gets the next available
   number(s) — same as a physical seller working through their stack in order — rather than
   choosing a specific one. Enforced server-side in `record_sale`, not just hidden in the UI:
   the manual/exact-number path now rejects any ticket number that resolves to a digital
   block. When the public buyer page is eventually built, lucky-number picking belongs there.
2. **An online series' display prefix (e.g. "O") is genuinely optional, confirmed.** Leaving
   it blank at campaign creation gives a plain numeric series — nothing forces a prefix; this
   was already how it worked, just confirming it here.
3. **No 24-hour hold window for online tickets — sticking with SumUp's native 30-minute
   session, superseding §11's speculative 24-hour idea.** An unpaid online ticket is released
   back to the pool once SumUp reports the link expired (the existing `STALE_MINUTES = 35`
   sweep already does exactly this — no code change needed). This removes the need for the
   "keep one link alive across a longer window" intermediary-page idea from §11 — but that
   section's *other* point stands on its own regardless: a proper post-payment confirmation
   page (with a Save button) is still wanted, and SumUp's redirect still shouldn't land a
   buyer on raw API output. That remains open, alongside the rest of the buyer-direct flow.

---

## 14. Online ticket replica: parish address + free-text campaign details — decided 2026-09-22

Justin supplied the actual physical ticket design (Christmas Raffle 2026) to base the online
"Share ticket" replica on. Two pieces of content on it weren't stored anywhere: the parish's
address, and the raffle-specific content (prize structure, draw date, tagline, footer note,
winner-notification policy).

**Decided:** rather than rigid fields (`prizes`, `draw_date`, ...) that wouldn't generalize
to other campaign types (a dinner has neither), added:
- `organizations.address` — set once by a SuperAdmin, shown on every ticket message from
  every campaign that Organization runs.
- `campaigns.details_text` — free text, written once per campaign by a SuperAdmin, reused
  verbatim in every ticket confirmation for that campaign. Deliberately unstructured so it
  fits whatever a given campaign actually needs.

The "Share ticket" message (shown once a sale — physical or online, any payment method —
is confirmed) now includes: parish name and address, the campaign's own details_text (if
any), the tier breakdown, ticket number(s) with their display prefix, price, buyer name, and
sale date/time — matching the physical ticket's own content structure.

---

## 15. Post-payment confirmation page — built 2026-09-22

Fixes the gap identified in §11 and refined by Justin: SumUp was redirecting a buyer's own
browser to the JSON webhook endpoint after paying, not a real page. The content also needed
to differ by ticket type, which Justin correctly identified as the key distinction: a
**physical** ticket was already handed over at the point of sale, so payment confirming is
just an acknowledgment ("thank you, payment received") — nothing to show or save, since the
buyer already holds the real thing. An **online** ticket has no physical form, so its
confirmation page IS effectively the ticket, and needs the full replica plus a way to keep it.

**Built:**
- `return_url` now points to `/ticket.html?payment_id=<id>` — a real, standalone page, not
  the API endpoint. `/ticket.html` is public (no login), works entirely off that one
  unguessable id, and calls a new public backend action for its content.
- `public_payment_status` (no session required) — deliberately narrow: identified only by
  the payment's own id, discloses nothing sensitive (no seller identity, no other buyers),
  and its status always comes from a fresh `syncCheckout` call to SumUp, never trusted from
  the request. Fetches the sale's ticket rows *before* calling `syncCheckout`, since an
  expired online sale has those rows released (cleared) as a side effect of that call —
  fetching after would wrongly show no tickets and default to "physical".
- Four states on `/ticket.html`: **paid + physical** (thank-you only), **paid + online**
  (full replica: parish name/address, campaign details, ticket number(s), tier breakdown,
  price, buyer, date — plus a Save button), **pending** (auto-rechecks every 6s), **failed/
  expired** (physical: ticket's still with you, pay another way; online: number's likely
  gone to someone else, ask for a fresh link).
- The "Save" experience is a client-side-generated PNG (HTML canvas, no server-side image
  generation or library) — both a long-press-to-save `<img>` (for iOS) and a direct download
  link (for Android/desktop).

This also directly serves the future buyer-direct purchase flow (§10's open item): once that
public purchase page exists, it will land the buyer on this same `/ticket.html` confirmation
after paying, unchanged.

---

## 16. Buyer-direct public purchase page — built 2026-09-22

Closes §10's remaining open item. A buyer can now purchase an online ticket with no seller
involved, sharing every principle already decided:

- **Reachable only via a campaign-specific link** (`/buy.html?campaign_id=<id>`), copied from
  the Campaigns tab ("Copy public link", shown only for a campaign with an online block) —
  not a general marketplace browsing every campaign across the platform.
- **Online tickets only.** A physical ticket needs an in-person handover that doesn't exist
  here, so the public actions only ever touch digital blocks of an active, non-binned
  campaign.
- **Always Pay by Link.** No seller to vouch for cash or a machine tap.
- **Lucky-number picking IS allowed here** — this is specifically the flow §13 reserved it
  for. "Any available" (the same atomic lowest-numbered claim as the seller flow) is the
  other option.
- **Lands on the same `/ticket.html` confirmation page** built in §15, unchanged — the buyer
  pays, SumUp redirects them there, they see their ticket and can save it.

**Three new public (no-session) actions**, all narrowly scoped and never trusting the
caller: `public_campaign_info` (what to show before paying), `public_check_ticket` (live
lucky-number availability), `public_purchase` (creates the sale — capped at 20 tickets per
transaction as a sanity limit, not a business rule). `payments.seller_id` is now nullable to
represent "no seller involved" as a real case; every place a seller name is shown now reads
"Online (self-service)" for a null seller_id rather than "Unknown", via a shared
`sellerLabel()` helper.

---

## 17. Platform Owner account recovery — deliberately narrow — built 2026-09-23

Question: what happens if a parish's only SuperAdmin is locked out (lost/changed phone,
forgot password)? Two shapes were considered:

- **Broad**: let the Platform Owner "enter" any parish as if they were its SuperAdmin —
  full visibility into that parish's campaigns, sales, and users.
- **Narrow (chosen)**: the Platform Owner can only *find* a SuperAdmin (by mobile number,
  the one identifier they have) and *reset their password* or *enable/disable* their
  account. No visibility into that parish's campaigns, sales, or other users at all.

Narrow was chosen because the Platform Owner's job is running the platform, not seeing
inside any one parish's affairs — the same boundary that already keeps `platform_owner`
separate from `superadmin`/`admin`/`seller` elsewhere in the role model. Recovering a
locked-out Admin or Seller stays the job of their own parish's SuperAdmin; this tool exists
only for the case where the SuperAdmin themself is the one locked out.

**Three new actions**, all `requireRole(['platform_owner'])`:
- `platform_find_user` — looks up by mobile number, filtered to `role = 'superadmin'`;
  returns just enough to confirm identity (name, parish name, active status) — nothing else
  about that parish.
- `platform_reset_superadmin_password` — sets a new password (same 8+ character strength
  check as everywhere else). The new password is relayed to the SuperAdmin directly by the
  Platform Owner, out of band — never emailed or texted by the system.
- `platform_set_superadmin_active` — enable/disable toggle, for a departed or suspended
  SuperAdmin, separate from resetting their password.

Frontend: a fourth card on the Platform Owner's screen ("Recover a locked-out SuperAdmin"),
alongside the existing Organizations / Add parish / Add first Admin cards.

---

## 18. Add a series to an existing campaign — built 2026-09-25

The BBQ parent site let a campaign gain extra series after creation; the rebuild only
allowed blocks at creation time. Now a SuperAdmin can add a physical top-up or a second
online series to any existing (non-binned) campaign (`add_block_to_campaign`, "Add a series
to an existing campaign" card on the Campaigns tab).

- The new range may not overlap **any** ticket number already in that campaign (physical
  sales resolve tickets by campaign + number, so a shared number would be ambiguous). The
  error names the clashing numbers.
- Series names must be unique within a campaign; if left blank they default to "Series N"
  (physical) or "Online N".
- Shares block/ticket creation with `create_campaign`; a failed insert removes the
  half-built series. Sanity cap of 50,000 tickets per series (not a business rule).

---

## 19. Weak-signal resilience & safe link resend — built 2026-09-25

Sellers stand in places in the church with poor reception. The pages were already tiny
(index ~17 KB over the wire, no external libraries); the real risk was a **lost reply**:
the sale saves, the confirmation never arrives, the seller taps again, and a second sale is
made. Changes:

- **Retry-safe sales.** Each sale attempt carries a random `client_ref` (unique index on
  `payments.client_ref`). A retry with the same reference returns the ORIGINAL sale
  (`replaySale`) — including under three simultaneous identical requests — instead of
  creating another. Same for the public buy page. Changing anything about the sale starts a
  fresh reference; a server-side failure ends the attempt so the next tap is a new one.
- **Timeouts and plain messages.** Requests give up after 20s (60s for admin bulk actions)
  with "signal may be weak" wording; buttons lock while a sale is recording.
- **One round trip for the Sell screen** (`sell_screen`: campaigns + parish + stats, was
  three sequential calls). A failure shows a Try-again card and loses nothing typed.
- **App page cached on the phone** (`sw.js`, network-first with a 4s wait) so it opens with no
  signal. Sales themselves always need the network — offline sale queueing was rejected
  (two sellers could claim the same number while disconnected).
- **QR code removed.** Payment links go by WhatsApp/SMS/email; every message now states the
  30-minute validity (wording differs: physical = ask for a fresh link, online = number is
  released).
- **Seller resend.** A seller may issue a fresh link for their OWN sale of PHYSICAL tickets,
  only once the old link is dead (expired/failed per SumUp). A still-live link is simply
  re-shared. An Admin replacing a live link, and Void, now CANCEL the old SumUp checkout first
  (SumUp refuses if it was just paid), so two payable links can never exist for one sale.
- Rejected/not possible: choosing the Netlify function region is Pro-plan only.
