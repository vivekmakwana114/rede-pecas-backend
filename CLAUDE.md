# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Rede Peças — central API backend for a WhatsApp AI sales agent (auto parts marketplace in Angola) and its admin approval panel. The AI agent converses with customers over the Meta WhatsApp Cloud API, identifies their vehicle (VIN or guided steps), searches inventory, generates proforma PDFs, and walks them through payment; staff approve orders via the admin API (consumed by the separate `rede-pecas-admin` React repo at `D:\Invennico\rede-pecas-admin`).

See `PROJECT_PROGRESS.md` for the current status against the SOW, known gaps, and the agreed next steps — read it before planning any feature work, and keep it updated when a gap listed there is closed.

## Commands

```bash
npm run dev        # nodemon + ts-node/esm, watches src/
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

1. CRM registration (new customer → guided name → NIF → address flow; `customers.registration_status`)
2. Media (image/document) → treated as payment proof (`processPaymentProof`)
3. Active manual vehicle collection (make → model → year → engine number step machine)
4. 17-char VIN detected → NHTSA decode → confirm buttons (falls back to manual collection on decode failure)
5. Vehicle confirmation reply (Sim/Não)
6. Order awaiting payment input (`awaiting_payment_method` / `awaiting_*_subtype` states)
7. Fallback: conversational Claude agent

New message-handling behavior must slot into this chain deliberately — position determines what can intercept what (e.g. today any image is consumed as a payment proof, even mid-vehicle-identification; a known gap — see "Intended end-to-end workflow" below, image routing is agreed to become state-aware).

### Conversational state

State is per-phone-number and lives in two places:

- **PostgreSQL** — durable step-machine state: `customers.registration_status`, `manual_vehicle_collections.status`, and `orders.status` (state machine in `src/services/payment.service.ts`: `awaiting_payment → awaiting_payment_method → awaiting_bank_subtype | awaiting_in_person_subtype → awaiting_payment_proof | awaiting_agent_confirmation → payment_proof_received → approved | rejected`).
- **Redis** — rolling 20-message conversation history (key `session:<phone>`) and pending search options awaiting the customer's numeric choice (key `options:<phone>`), both 4h TTL (`src/services/session.service.ts`), with silent in-memory fallback when Redis is down.

The AI agent (`processAIConversation`) sends this history plus a system prompt to Claude; replies are either plain text (forwarded to the customer) or a structured JSON action (`search` / `confirm_order` / `transfer_to_human`, English keys) dispatched by `executeStructuredAction`.

### Known duplication

`src/services/ai.service.ts` contains an unused, cleaner copy of the agent call (`callAIAgent`) plus a Claude Vision document extractor (`extractDataWithClaudeVision`) that is not wired into the webhook. The live agent logic (and system prompt) is inlined in `whatsapp.controller.ts` on a different model version. Consolidation is a pending task — don't extend both copies.

### Intended end-to-end workflow (agreed with Vivek, 2026-07-02)

The target customer journey is documented in full in `PROJECT_PROGRESS.md` → "Full intended workflow". Three decisions from that discussion change the architecture described above and are **not yet implemented**:

- **Onboarding becomes a single merged flow.** Registration (name→address→NIF) and vehicle ID (VIN, document/photo, or manual entry) are to become one step machine for new customers, replacing the two independent step machines that exist today (pipeline stages 1 and 3/4 above). Don't restructure this until the merge lands — treat it as a planned refactor, not current behavior.
- **Image routing must become state-aware before Claude Vision is wired in.** Route incoming images by the customer's current conversation state (awaiting vehicle ID → treat as vehicle document; awaiting payment proof → treat as payment proof), replacing today's unconditional "any image = payment proof" at pipeline stage 2. Wiring `extractDataWithClaudeVision` into the webhook without this fix first will cause vehicle documents sent during onboarding to be swallowed as payment proofs.
- **Staff/admin WhatsApp notification trigger moves earlier.** It currently fires when a payment proof lands or presential payment is chosen; the agreed target is to fire at order creation (proforma sent) instead. No email notification — none exists in this codebase and none was added to scope.

Refund tracking on order rejection was explicitly decided *against* — it stays a message-only "refunded within 3–5 business days" notice with no new order status, consistent with payment gateway integration being out of scope per the SOW.
