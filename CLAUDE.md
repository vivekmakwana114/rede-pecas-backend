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

Boot requires a `.env` at the project root (copy `.env.example`) — `src/config/config.ts` throws at import time if any of these are missing: `DATABASE_URL`, `ANTHROPIC_API_KEY`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `JWT_SECRET`. Redis (`REDIS_URL`) is optional — sessions fall back to an in-memory Map.

## Critical conventions

- **Language split**: code identifiers, DB tables/columns, stored status values, API routes, and JSON payload keys are **English**. Customer-facing content is **Portuguese (Angola)** and must stay that way: WhatsApp messages to customers/staff/suppliers, PDF document text, and the AI prompt bodies (their embedded JSON action keys are English — machine protocol). Part data (names, synonyms) is Portuguese, which is why the full-text search uses the `'portuguese'` config.
- **ESM with NodeNext resolution**: `"type": "module"` + `moduleResolution: NodeNext`. All relative imports **must use the `.js` extension**, even inside `.ts` files (`import { config } from '../config/config.js'`). Omitting it breaks the build.
- Layering is `routes → controllers → services → models`, with raw `pg` queries in `src/models/` (no ORM) against a shared `Pool` from `src/config/db.ts`. Config is only read via the `config` object, never `process.env` directly.
- **Schema lives in `db/schema.sql`** (with `db/seed.sql` and `db/schema.dbml` for dbdiagram.io). SQL in models must match it — when you change one, change all three.
- Errors: throw `ApiError` (from `src/utils/ApiError.ts`), wrap async route handlers in `catchAsync`; `errorConverter`/`errorHandler` in `src/middlewares/error.ts` produce `{ error: message }` JSON responses. Admin routes validate input with Joi via `validate(schema)` and schemas in `src/validations/`.
- Logging goes through the Winston `logger` in `src/config/logger.ts`, not `console`.

## Architecture

Two route groups mounted under `/v1` (`src/routes/v1/index.ts`):

- `/v1/webhook/whatsapp` — Meta webhook. GET is the verification handshake; POST is the message intake, which **responds 200 immediately** (Meta's 5-second rule) and then processes asynchronously. Errors after that point are logged, never returned to Meta.
- `/v1/admin` — JWT-protected (single shared password login → token via `authMiddleware`): `/orders` list, `/orders/:number/approve|reject`, `/inventory/upload` batch import. The admin panel (`rede-pecas-admin`) depends on these exact paths and payload keys (`pending`/`approved`, order fields `number, customer, part, reference, supplier, price, time, has_proof`).

### The message pipeline (the heart of the system)

`processMessageFlow` in `src/controllers/whatsapp.controller.ts` routes every incoming message through a strict priority chain — earlier stages short-circuit later ones:

1. CRM registration (new customer → guided name → NIF → address flow; `customers.registration_status`). Registration and vehicle ID are one merged onboarding flow: completing the address step sets `registration_status = 'awaiting_vehicle_id'` instead of `complete` — that status is explicitly excluded from this gate so stages 3–6 below (already fully general) handle it, rather than being re-implemented here.
2. State-aware image routing: while a vehicle ID is pending (`registration_status === 'awaiting_vehicle_id'` or an active manual collection), an image is treated as a vehicle document (`processVehicleDocument`, via Claude Vision) instead of a payment proof.
3. Media (image/document) not caught by stage 2 → treated as payment proof (`processPaymentProof`)
4. Active manual vehicle collection (make → model → year → engine number step machine)
5. 17-char VIN detected → NHTSA decode → confirm buttons (falls back to manual collection, now with a message, on decode failure)
6. Vehicle confirmation reply (Sim/Não) — if this completes a pending onboarding, flips `registration_status` to `complete` and sends the combined welcome message
7. Still `awaiting_vehicle_id` and nothing above matched (e.g. non-VIN text with no VIN typed and no document sent) → starts manual collection deterministically rather than falling through to the AI agent
8. Order awaiting payment input (`awaiting_payment_method` / `awaiting_*_subtype` states)
9. Fallback: conversational Claude agent

New message-handling behavior must slot into this chain deliberately — position determines what can intercept what.

### Conversational state

State is per-phone-number and lives in two places:

- **PostgreSQL** — durable step-machine state: `customers.registration_status`, `vehicles.status` (the merged per-customer vehicle-identification table — see below), and `orders.status` (state machine in `src/services/payment.service.ts`: `awaiting_payment → awaiting_payment_method → awaiting_bank_subtype | awaiting_in_person_subtype → awaiting_payment_proof | awaiting_agent_confirmation → payment_proof_received → approved | rejected`).
- **Redis** — rolling 20-message conversation history (key `session:<phone>`) and pending search options awaiting the customer's numeric choice (key `options:<phone>`), both 4h TTL (`src/services/session.service.ts`), with silent in-memory fallback when Redis is down.

The AI agent (`processAIConversation`) sends this history plus a system prompt to Claude; replies are either plain text (forwarded to the customer) or a structured JSON action (`search` / `confirm_order` / `transfer_to_human`, English keys) dispatched by `executeStructuredAction`.

### Known duplication

`src/services/ai.service.ts` contains an unused, cleaner copy of the conversational agent call (`callAIAgent`). The live agent logic (and system prompt) is inlined in `whatsapp.controller.ts` on a different model version. Consolidation is still a pending task — don't extend both copies. (The Vision document extractor `extractDataWithClaudeVision` from the same file **is** now wired into the webhook, via `processVehicleDocument` — no longer duplicated/unused.)

### Intended end-to-end workflow (agreed with Vivek, 2026-07-02)

The target customer journey is documented in full in `PROJECT_PROGRESS.md` → "Full intended workflow". Of the three decisions from that discussion:

- **Onboarding is now a single merged flow** (implemented 2026-07-02): registration (name→NIF→address) and vehicle ID (VIN typed, document/photo via Claude Vision, or manual entry) are one continuous step machine — see the message pipeline above.
- **Image routing is now state-aware** (implemented 2026-07-02): resolved as part of the same change, since it was a hard prerequisite for wiring in Vision.
- **Staff/admin WhatsApp notification trigger moving to order creation** — still **not implemented**; it currently fires when a payment proof lands or presential payment is chosen. No email notification — none exists in this codebase and none was added to scope.

Refund tracking on order rejection was explicitly decided *against* — it stays a message-only "refunded within 3–5 business days" notice with no new order status, consistent with payment gateway integration being out of scope per the SOW.
