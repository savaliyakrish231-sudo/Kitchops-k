# KitchOps — Prep Kitchen Automation System

Phase 1 implementation of **User Master** and the **Recipe / Yield Database**, built to the
*New_Process_Automation_Dev.docx — Phase-wise Development Plan v10.2*.

## Running it

```bash
npm install
npm start                 # http://localhost:3000
```

On first start the database is created and a **Super Admin** account is generated. Its
credentials are written to `data/ADMIN_CREDENTIALS.txt` (gitignored). Sign in and change the
password immediately — the app will prompt you.

```bash
npm run migrate           # create/upgrade the schema only
npm run seed:kitchen      # load the real Central Kitchen Surat org chart
npm run seed:sample       # add SAMPLE test data (optional)
npm run seed:sample -- --clear
npm test                  # 73 API / business-rule tests
npm run test:ui           # 37 frontend rendering, theme + RBAC tests
npm run test:all          # both
```

Environment overrides: `PORT`, `KITCHOPS_DB`, `KITCHOPS_JWT_SECRET`,
`KITCHOPS_ADMIN_USER`, `KITCHOPS_ADMIN_PASS`.

## The architectural rule

> **v10.2 Rule 19 — stations MUST be configurable, never hardcoded.**

No station name appears anywhere in the code or schema. Stations live in the `stations` table
and every station dropdown is populated from `GET /api/meta/bootstrap`. Behaviour that used to
be per-station is driven by **`station_types` flags** instead of names:

| Flag | Effect on the engine |
|---|---|
| `requires_cut_method` | items routed here must have MACHINE/MANUAL set |
| `requires_cut_type` | items routed here must have a cut type set |
| `is_peeling` | consumes raw quantity, passes net on |
| `feeds_into_type` | which stage receives that output |
| `is_packing` | waits for all prep stations |

Adding a station in Station Master immediately makes it available in the Recipe DB picker, in
Counter Settings and as its own sheet — with no code change. This is covered by the
**TEST STATION** test in `test/run-tests.js`.

## Central Kitchen Surat

`npm run seed:kitchen` loads the kitchen org chart as real master data
(`is_sample = 0`), so it is fully editable in the UI and is never touched by the
"remove sample data" purge. Re-running it skips anything already present.

| Section (station) | Type | People |
|---|---|---|
| Dough — pizza dough, breads | Prep | Pritam, Jayesh, Bandhana |
| Pasta & Sauce — all pasta, all sauces | Prep | Shravan, Aftab |
| Dimsum — all dimsum items | Prep | Ranu, Pritam Gupta |
| Prep — cutting, chopping | **Cutting** | Smita, Kunal, Pritam Shah, Shiv |
| Beverage — all juices | Prep | Rana |

Management: Parth (CPK Executive Head, Super Admin), Rahul (Head Chef) and Mohit
(Sous Chef) as Prep Kitchen Admins — all sections report to Mohit.

Additional responsibilities are held alongside a section posting, not as a second
station: Kunal and Shravan are Vegetable Receiving Heads, Smita is Hygiene Head.

Generated sign-in passwords are written to `data/STAFF_CREDENTIALS.txt`
(gitignored). Everyone is forced to change theirs at first sign-in — delete the
file once they have been handed out.

**Prep** is the only Cutting-type section, so it is the only one whose recipe
items require a cut type and a MACHINE/MANUAL method.

## Appearance

Light / Dark / System, chosen per device and stored in `localStorage` — not in the
database, so one person's choice never restyles the app for the whole kitchen.
Everyone switches from the ☀/☾ button in the header; Super Admins also get the
full three-way picker under System Settings.

Dark mode is a token swap: every colour lives on `:root` in `public/css/app.css`
and the dark block redefines the same names. A component written against the
tokens themes itself — never hard-code a colour in a component.

MACHINE stays blue and MANUAL stays orange in both themes (v10.2 Rule 5), and
every text/background pairing clears WCAG AA 4.5:1. Both facts are enforced by
tests in `test/ui-smoke.js`, so a future palette edit cannot quietly break them.

## Order of data entry

1. **Station Master** — stations first; everything else references them.
2. **Location Master** — outlets.
3. **Supporting Masters** — cut types and item categories.
   The `requires_yield` flag on a category is what makes Yield % mandatory for its items.
4. **User Master** — users, with location or station assignment per role.
5. **Counter Settings** — the fixed person list per station.
6. **Recipe DB** — items, yield %, cut config, peeling, storage, frequency, location overrides.

The **Dashboard** shows a live readiness check and refuses sheet generation while any
documented configuration error remains.

## Yield

`server/services/yield.service.js` is the only place this arithmetic exists:

```
Raw Qty = Net Qty ÷ (Yield % ÷ 100)

1000 GM at 79%  ->  1000 ÷ 0.79  =  1265.82…  ->  1266 GM
```

The percentage is converted to its decimal fraction first. Rounding is half-away-from-zero,
which reproduces every worked example in v10.2 §1.10. A missing yield is **never** treated as
100% — it raises the documented error and blocks sheet generation.

## Layout

```
server/
  db/          schema.sql, connection, migrate (system vocabulary), seed-sample
  services/    yield · recipe-rules · recipe.repo · roster        <- all business rules
  middleware/  auth (JWT cookie + server-side RBAC)
  routes/      auth · meta · users · stations · locations · recipes · roster · validation
public/
  css/app.css  design system; MACHINE=Blue / MANUAL=Orange defined once
  js/pages/    one file per screen; no station/user/yield constants anywhere
test/
  run-tests.js API + business rules      ui-smoke.js  frontend rendering + RBAC
```

## Not in scope

Pet Pooja integration, stock management, auto-PO, vendor PO, notifications, analytics, demand
prediction, cost tracking and the Vegetable Washing Station are Phase 2–4 and are deliberately
absent.
