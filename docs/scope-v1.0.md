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
   way as a reader payment.
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
  and nothing to check. A digital sale gets a **Share** action that hands off
  to the seller's own phone's native share sheet (Messages/WhatsApp/Mail/etc.)
  — there is no way to auto-target one specific channel or contact; the
  seller picks who to send it to, the same way sharing a photo works.
- A campaign can have **only physical blocks, only a digital block, or
  both** (a genuine hybrid — e.g. a printed ticket book alongside an online
  sales channel for the same campaign).

This reframes Non-negotiable #8 (displayed data must match physical reality)
for the digital case: the ticket identifier shown to the seller and the one
sent to the buyer must always match exactly — there's no "physical" to check
against, so that consistency is the digital equivalent of the same rule.
