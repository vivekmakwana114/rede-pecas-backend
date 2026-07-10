# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Rede Peças — central API backend for a WhatsApp AI sales agent (auto parts marketplace in Angola) and its admin approval panel. The AI agent converses with customers over the Meta WhatsApp Cloud API, identifies their vehicle (VIN or guided steps), searches inventory, generates proforma PDFs, and walks them through payment; staff approve orders via the admin API (consumed by the separate `rede-pecas-admin` React repo at `D:\Invennico\rede-pecas-admin`).

See `PROJECT_PROGRESS.md` for the current status against the SOW, known gaps, and the agreed next steps — read it before planning any feature work, and keep it updated when a gap listed there is closed.

## Commands

```bash
npm run dev        # tsx watch, watches src/
npm run build      # tsc → dist/
npm start          # node dist/index.js (requires build)
npm run lint       # eslint src
npm run db:migrate # apply db/schema.sql to DATABASE_URL
npm run db:seed    # migrate + insert db/seed.sql sample data
```

There are no tests yet (no test runner is configured).

Boot requires a `.env` at the project root (copy `.env.example`) — `src/config/config.ts` throws at import time if any of these are missing: `DATABASE_URL`, `ANTHROPIC_API_KEY`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `JWT_SECRET`. Redis (`REDIS_URL`) is optional — sessions fall back to an in-memory Map. Admin login needs at least one row in `admin_users` — `db/seed.sql` inserts a dev account (`admin@redepecas.ao` / `admin123`).

## Critical conventions

- **Language split**: code identifiers, DB tables/columns, stored status values, API routes, and JSON payload keys are **English**. Customer-facing content is **Portuguese (Angola)** and must stay that way: WhatsApp messages to customers/staff/suppliers, PDF document text. Part data (names, synonyms) is Portuguese, which is why the full-text search uses the `'portuguese'` config. The two AI vision-extraction prompt bodies (`src/services/ai.service.ts`) are the one exception — the model only ever sees them, never the customer, so they were switched to **English** (as of 2026-07-10) since Claude reasons more reliably in English; their embedded JSON field keys were already English (machine protocol).
- **ESM with NodeNext resolution**: `"type": "module"` + `moduleResolution: NodeNext`. All relative imports **must use the `.js` extension**, even inside `.ts` files (`import { config } from '../config/config.js'`). Omitting it breaks the build.
- Layering is `routes → controllers → services → models`, with raw `pg` queries in `src/models/` (no ORM) against a shared `Pool` from `src/config/db.ts`. Config is only read via the `config` object, never `process.env` directly.
- **Schema lives in `db/schema.sql`** (with `db/seed.sql` and `db/schema.dbml` for dbdiagram.io). SQL in models must match it — when you change one, change all three.
- **Every admin API response shares one envelope** — success: `{ success: true, message, code, data, [accessToken], [refreshToken], meta: { timestamp } }`; error: `{ success: false, message, code, data: null, meta: { timestamp } }`. No stack trace is ever sent to the client (logged server-side only via `logger.error`, in `errorHandler`). There's no shared response-builder function — each controller writes its own `res.status(code).json({...})` literally; only the shape is a convention, not a helper. The WhatsApp webhook endpoints are the one exception (see below) — Meta's contract requires a bare 200 / raw challenge string, not this envelope.
- Errors: throw `ApiError` (from `src/utils/ApiError.ts`), wrap async route handlers in `catchAsync`; `errorConverter`/`errorHandler` in `src/middlewares/error.ts` produce the error envelope above. `validate(schema)` (`src/middlewares/validate.ts`) humanizes Joi's raw quoted-field messages (`"newPassword" is required` → `New Password is required`) before wrapping them in an `ApiError`. Admin routes validate input with Joi schemas in `src/validations/`.
- Logging goes through the Winston `logger` in `src/config/logger.ts`, not `console`.

## Architecture

Two route groups mounted under `/v1` (`src/routes/v1/index.ts`):

- `/v1/webhook/whatsapp` — Meta webhook. GET is the verification handshake; POST is the message intake, which **responds 200 immediately** (Meta's 5-second rule) and then processes asynchronously. Errors after that point are logged, never returned to Meta.
- `/v1/admin` — JWT-protected via `authMiddleware` (access-token payload: `{ id, email, role }`), individual accounts in `admin_users` (bcrypt password hashes, `adminAuth.service.ts`): `/login` (returns an access token, 1h default, + a refresh token, 30d default, stateless JWT with `type: 'refresh'` — `authMiddleware` rejects a refresh token used as a bearer token on any other route), `/refresh` (exchanges refreshToken for a new accessToken, no rotation/revocation), `/forgot/password` + `/reset/password` — identified by **phone**, not email (body: `{ phone }` / `{ phone, code, newPassword }`), since the 6-digit code is delivered over WhatsApp to that same number and there's no email/SMTP service in this project; `getAdminByPhone` compares digits-only so formatting in the stored `phone` column doesn't matter, `/profile` (GET/PATCH), `/change/password`; plus `/orders` list, `/orders/:number/approve|reject`, `/inventory/upload` + `/inventory/import` batch import. Route segments use `/` nesting, never hyphens. The admin panel (`rede-pecas-admin`) depends on these exact paths and payload keys (order fields `number, customer, part, reference, supplier, price, time, has_proof`, now nested under `data.pending`/`data.approved` — see the envelope convention above).

### The message pipeline (the heart of the system)

`processMessageFlow` in `src/controllers/whatsapp.controller.ts` routes every incoming message through a strict priority chain — earlier stages short-circuit later ones.

Customer profile registration and vehicle identification are **independent state machines**, each with its own status, so whichever is missing is what the bot asks for next — a returning customer whose vehicle session simply expired is sent back into the vehicle-ID flow without re-doing their profile:
- **Profile**: `customers.registration_status` — `awaiting_name → awaiting_nif → awaiting_nif_number → awaiting_address → complete`. Covers name/NIF/address only.
- **Vehicle ID**: derived on every message from the `vehicles` table itself (no ORM/status field on `customers`) — `needsVehicleId` is true when the profile is `complete`, there's no in-progress manual-entry wizard, and `vehicleService.hasVehicleOnFile` finds no confirmed row. There is no separate "awaiting" status to keep in sync; the table's own shape (absent row / in-progress wizard step / confirmed row — see `vehicle.model.ts`) is the state.

**A customer can have multiple confirmed vehicles.** `vehicles.id` is the primary key (not `phone` — a customer can have several rows). `vehicleService.startAddVehicleFlow` re-runs the same VIN/photo/manual choice on demand (triggered by the "➕ Outro carro"/"➕ Add vehicle" button always offered alongside the ask-part prompt, or the same phrase typed free-text — `vehicleService.isAddVehicleRequest`), and `saveVehicleSession` always inserts a new row unless given a specific in-progress row's `id`, so existing vehicles are never touched by adding another. When a search is about to happen and the customer has 2+ vehicles, `sendAskPartPrompt` asks "which vehicle is this for?" first (`sessionService.savePendingVehicleChoice`/`getPendingVehicleChoice`) and `ai.service.ts` uses the resolved choice (`sessionService.getChosenVehicle`) instead of guessing.

Pipeline order:

1. Profile registration (new customer → guided name → NIF → address flow). Once `complete`, vehicle ID continues below via the normal stages instead of being re-intercepted here.
2. Explicit "add another vehicle" request (button or typed) — only once the customer already has at least one vehicle.
3. Vehicle-ID option button tap (VIN / photo / manual), shown whenever `needsVehicleId` is true, or the choice buttons were just shown (including via "add another vehicle" — `sessionService.wasVehicleIdChoiceShown`).
4. State-aware image routing: while vehicle ID is needed (missing, an active manual collection, or the choice buttons were just shown), an image is treated as a vehicle document (`processVehicleDocument`, via Claude Vision) instead of a payment proof.
5. Media (image/document) not caught by stage 4 → treated as payment proof (`processPaymentProof`)
6. Active manual vehicle collection (make → model → year → engine number step machine)
7. 17-char VIN detected → NHTSA decode → confirm buttons (falls back to manual collection, now with a message, on decode failure)
8. Vehicle confirmation reply (Sim/Não) — "Não" deletes only the just-rejected row (`vehicleService.getMostRecentVehicle` + `clearVehicleSession(id)`), never any other vehicle on file. If this is the customer's first-ever confirmed vehicle (`customers.registered_at` still `NULL`), stamps `registered_at` and sends the combined welcome message instead of the lighter "what part do you need" prompt
9. Pending "which vehicle is this for?" reply (2+ vehicles) — must resolve before the waitlist/confirmation checks below, which also interpret short numeric/yes-no replies
10. `needsVehicleId` still true and nothing above matched (e.g. non-VIN text with no VIN typed and no document sent) → starts manual collection deterministically rather than falling through to product search
11. Order awaiting payment input (`awaiting_payment_method` / `awaiting_*_subtype` states)
12. Part-search gate: free text is only ever treated as a product search once the customer has actually been asked "what part do you need" this session (`sessionService.wasPartPromptSent`) — otherwise (or on a bare greeting, PT/EN, matched via `GREETING_PATTERN` — this always wins even if already invited) the bot (re-)sends that deterministic prompt instead
13. Reply to a just-shown product search-results list (row tap or typed digit, `sessionService.getPendingOptions` + `productService.processProductSelection`) — not selection-shaped (e.g. a new part name typed instead) falls through to a fresh search below rather than a dead end
14. Explicit request to talk to a human — deterministic keyword match (`HUMAN_HANDOFF_PATTERN` in `whatsapp.controller.ts`), no AI judgment call
15. Fallback: deterministic product search (`productService.searchAndRespond`) — full-text match against the inventory DB, no AI involved

New message-handling behavior must slot into this chain deliberately — position determines what can intercept what.

### Conversational state

State is per-phone-number and lives in two places:

- **PostgreSQL** — durable step-machine state: `customers.registration_status`, `vehicles.status` (the merged per-customer vehicle-identification table — see below), and `orders.status` (state machine in `src/services/payment.service.ts`: `awaiting_payment → awaiting_payment_method → awaiting_bank_subtype | awaiting_in_person_subtype → awaiting_payment_proof | awaiting_agent_confirmation → payment_proof_received → approved | rejected`).
- **Redis** — pending search options awaiting the customer's list tap or typed digit (key `options:<phone>`), 4h TTL (`src/services/session.service.ts`), with silent in-memory fallback when Redis is down.

### No conversational AI (as of 2026-07-09)

There is no conversational AI agent anywhere in the WhatsApp flow. Product search (`productService.searchAndRespond`) is a deterministic full-text query against the inventory DB (`plainto_tsquery('portuguese', ...)`, already synonym/typo-tolerant) on the customer's raw message — no query cleanup, no intent parsing. Results are sent as a WhatsApp **List Message** (`whatsapp.service.ts` → `sendWhatsAppList`, up to 3 rows, cheapest first) rather than a numbered text message; the customer's reply (row tap or typed digit) is resolved deterministically by `productService.processProductSelection`, same style as the existing Sim/Não handlers elsewhere in the pipeline. "Talk to a human" is a plain keyword match (`HUMAN_HANDOFF_PATTERN`), not an AI inference.

The **only** AI calls anywhere in this codebase are two Claude Vision extraction calls, both in `src/services/ai.service.ts`, both on the `claude-haiku-4-5-20251001` model:
- `extractDataWithClaudeVision` — vehicle document/VIN photo extraction, wired in via `processVehicleDocument`.
- `extractPaymentProofData` — payment-proof image extraction, wired in via `processPaymentProof` in `payment.service.ts`. Only runs when the proof is an image (Vision can't inspect a PDF proof); an image proof that comes back `valid: false` (e.g. not actually a receipt, illegible) asks the customer to re-upload instead of advancing `orders.status`.

Neither call ever sees customer chat text — both take an image only. There is no system prompt, no JSON action dispatch, and no Redis-held conversation history anymore (the old rolling 20-message `session:<phone>` key and `getHistory`/`saveHistory` were removed as dead weight along with the agent that used them).

### Intended end-to-end workflow (agreed with Vivek, 2026-07-02; registration/vehicle split reversed 2026-07-07)

The target customer journey is documented in full in `PROJECT_PROGRESS.md` → "Full intended workflow". Of the three decisions from that discussion:

- **Onboarding was a single merged flow from 2026-07-02, split back into two independent state machines on 2026-07-07** (registration and vehicle ID have their own status again — see the message pipeline above): the merge made it impossible to resume "just the vehicle" for a returning customer whose vehicle session expired without also re-checking profile status, and complicated adding more independent-status entities (e.g. suppliers) the same way later.
- **Image routing is now state-aware** (implemented 2026-07-02): resolved as part of the same change, since it was a hard prerequisite for wiring in Vision. Still keyed off `needsVehicleId` after the 2026-07-07 split, just computed differently.
- **Staff/admin WhatsApp notification trigger moving to order creation** — still **not implemented**; it currently fires when a payment proof lands or presential payment is chosen. No email notification — none exists in this codebase and none was added to scope.

Refund tracking on order rejection was explicitly decided *against* — it stays a message-only "refunded within 3–5 business days" notice with no new order status, consistent with payment gateway integration being out of scope per the SOW.
