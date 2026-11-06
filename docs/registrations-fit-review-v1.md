# Registrations: does it cover the four Jotforms? (review v1, 2026-11-06)

Method: each form was downloaded and every question, option, rule and note listed; each was then compared with what the registration
feature really does, read from the code (`netlify/functions/api.js`: `cleanFormDef`, `REG_FIELD_TYPES`, `setRegistrationForm`,
`registrationsExport`; `public/index.html`: form builder and responses screen; `public/register.html`). Facts about the app are
**(checked in code)**. Nothing was built or changed.

## 1. What the feature does today

Question types: short answer, long answer, number, date, **choose one** (dropdown, 2 to 40 options), yes/no, phone, email, UK address,
file or photo. Up to 40 questions. Per question: required, a hint, and a "sensitive" flag. Agreements: up to 8, each required or optional,
the exact wording stored with each answer. Contact: name plus mobile or email (or both). Optional: places limit and waiting list; opening
and closing dates; automatic deletion; approval (accept or decline with a note); payment of an amount the person chooses between a minimum
and a maximum, paid at the moment they submit. Staff side: responses list with search and status filter, one response in detail, CSV
download of all answers. Access: SuperAdmin, Finance and Priest only, after the confidentiality statement.

## 2. The four forms

| Form | Questions | Fits today | Main gaps |
|---|---|---|---|
| **Altar Servers: Bronze Medal** | about 12 | **About 85%** | pick-several for "which Mass"; a message shown only if the answer is "No" |
| **Senior Citizens' Christmas Dinner** | about 12 | **About 70%** | questions that appear only for some answers; a companion counts as a second place; no count of main-course choices |
| **Nativity Play** | about 23 | **About 65%** | four different role lists depending on the child's sacramental stage; several pick-several questions; section headings and notes |
| **Special Mass and church booking request** | about 22 | **About 55%** | choice with "Other, please type"; time of day; signature; a calendar of slots; a donation and refundable deposit that are agreed and paid after approval |

The percentages are my rough judgement of how much of each form could be captured as it is today without awkward workarounds, not a measurement.

None of the four takes payment on the form itself (the Special Mass form only states a suggested donation and a refundable £50 deposit,
and says they are arranged with the parish office).

## 3. What is missing, in the order it matters

| # | Gap | Needed by | Note |
|---|---|---|---|
| 1 | **Pick several (tick boxes)**, with an optional "up to N" | Nativity (3), Altar, Dinner | The dropdown only allows one answer |
| 2 | **Show or require a question only for some answers** | all four | Nativity branches four ways on sacramental stage; Dinner on how they travel and whether a companion comes; Mass request on own priest and out-of-hours |
| 3 | **Notes and section headings between questions** | all four | The forms use headings and explanatory notes (fees, rehearsal rules, eligibility) |
| 4 | **Edit the questions in the app** | all | The server allows editing until the first person registers (**checked**: `setRegistrationForm`) but **there is no screen for it**; today a form must be rebuilt to change one word |
| 5 | **Several places in one registration** | Dinner | "Companion also having the meal" needs two seats; today one registration is always one place, so capacity and catering numbers would be wrong. (The Jotform also never asks the companion's meal choice.) |
| 6 | **Count of answers per choice** and a printable list | Dinner (meals, lifts), Nativity (role preferences) | Only a CSV download exists |
| 7 | **"Other, please type"** on a choice | Mass request | |
| 8 | **Tell the office a new registration arrived** | all, most of all the Mass request | The app sends no email at all (**checked**: no mail service). Jotform emailed the office. Minimum: a "new" count on the tab; proper email needs the sending service planned for the platform core |
| 9 | **Let a volunteer coordinator see one form's responses** | Nativity facilitators, Altar server master, SVP dinner volunteers | Today only SuperAdmin, Finance and Priest can; a per-form viewer is needed |
| 10 | **Time of day**, a **signature** (a typed name plus the tick is usually acceptable; confirm with the office), and an **appointment slot picker** | Mass request | The slot picker is really calendar booking: it belongs with Spaces, not registrations |
| 11 | **Approve first, then pay**, a fixed-amount item (the £50 deposit), and tracking that a deposit was refunded | Mass request | Today payment is only at submit and is a free amount between a minimum and maximum |

Smaller: the Jotforms use US-style dates (month first) and phone hints, and an all-countries address list; the app uses day-first dates
and a UK address. Children's details, sacramental stage, mobility, health and dietary information are sensitive: mark those questions
"sensitive" when rebuilding.

## 4. The special Mass request is a different kind of thing

It books **the church at a date and time** (an anniversary Mass, a wedding, a funeral, chaplaincy), against the liturgical calendar,
with a donation and a refundable deposit. That is booking a space, not registering a person. Registrations can **collect the request**
(contact, wishes, preferred and alternative date, agreements, approval) but cannot check the calendar, take the donation after approval,
or manage the deposit and refund. Hall Booking already handles bookings, deposits and refunds. Recommendation: make it a **request form
now** (registrations, with approval, no payment on the form), and later make "the church" a bookable space on the platform so approval
leads to a payment link and a deposit record. Do not stretch registrations to cover it.

## 5. Proposed build ("Registrations 2"), preview first

1. The editor screen for questions (gap 4).
2. Pick several (1), notes and headings (3), "Other, please type" (7).
3. Show or require only for some answers (2).
4. Number of places per registration (5) and counts per choice with a printable list (6).
5. A "new" count on the Registrations tab (8, minimum); a per-form viewer (9).
6. Then rebuild the Altar Servers form first (simplest), then the Dinner, then the Nativity Play, comparing each against its Jotform.
Items 10 and 11 wait for the platform's Spaces and payments work.
