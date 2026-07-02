# Rede Peças — Progress Report

## Update — 2026-07-02 (onboarding merge)

- **Onboarding merged into one flow.** Registration (name → NIF → address) no longer completes on its own — the address step now sets `customers.registration_status = 'awaiting_vehicle_id'`, and registration only reaches `complete` once vehicle ID also finishes (VIN typed, document photo, or manual entry). See `CLAUDE.md` → "The message pipeline" for the updated stage order.
- **State-aware image routing landed**, resolving the prerequisite blocker for Vision: while a vehicle ID is pending, an incoming image is routed to `processVehicleDocument` instead of `processPaymentProof`.
- **Claude Vision document reading wired in.** `extractDataWithClaudeVision` (`ai.service.ts`) is no longer dead code — `processVehicleDocument` in `whatsapp.controller.ts` calls it, cross-checks any legible VIN against the free NHTSA API (preferred over OCR when available), and reuses the existing Sim/Não confirmation flow.
- **Bug fixed in passing:** `processVIN`'s decode-failure branch started a manual collection but never told the customer to type the make — silently stalled the conversation. Now sends a prompt.
- New `downloadWhatsAppMedia` helper in `whatsapp.service.ts` (Meta Graph API media download → base64), used by the Vision path.
- No schema changes required — `vehicle_sessions` already had every column needed, and `registration_status` is unconstrained TEXT.

## Update — 2026-07-02

- **English conversion done (backend + admin panel).** All code identifiers, DB tables/columns, stored status values, API routes (`/admin/orders`, `/orders/:number/approve|reject`), and JSON payload keys are now English. Customer-facing WhatsApp copy, PDF text, and AI prompt bodies remain Portuguese by design. See CLAUDE.md "Language split".
- **Schema ported into this repo** as `db/schema.sql` (English identifiers) + `db/seed.sql` + `npm run db:migrate` / `db:seed`. `db/schema.dbml` added for dbdiagram.io. `.env.example` added.
- **Bug fixed:** order confirmation flow — pending search options were stored as a custom property on the history array and silently lost on save; now persisted under a dedicated Redis key (`options:<phone>`) and cleared after order creation.
- **Search fixed:** `searchPartsInInventory` now uses the schema's generated `search_vector` column (GIN-indexed, accent-insensitive) instead of recomputing an inline `to_tsvector` that bypassed the index.
- Env var renames: `TELEFONE_FUNCIONARIO_REDE_PECAS` → `STAFF_PHONE_NUMBER`; Primavera config centralized in `config.ts` (`PRIMAVERA_API_URL`, `PRIMAVERA_API_TOKEN`); admin panel API base URL now configurable via `VITE_API_URL`.

Status of the codebase as reviewed on 2026-07-01, mapped against the 7 scope areas from the Unik Infoways SOW. Grounded in the actual code across three repos:

- `rede-pecas-backend` — Node.js/TypeScript central API (this repo)
- `rede-pecas-admin` — React/Vite admin approval panel
- `files (2)/rede-pecas-agent` — original JS prototype the backend was ported from

Legend: ✅ Done &nbsp; 🟡 Partial / needs wiring &nbsp; ❌ Missing

---

## Full intended workflow (agreed with Vivek, 2026-07-02)

The customer-facing journey the system is meant to support, end to end. Not all of this is built yet — see the decisions and gap cross-references below.

1. Customer messages the WhatsApp number.
2. System checks returning vs. new customer.
3. **New customer**: WhatsApp already supplies phone + profile name. System then runs one continuous guided onboarding: name → address → NIF → vehicle ID (VIN typed, vehicle document/photo, or manual make/model/year/engine number).
4. VIN (typed or read off an uploaded document) is decoded via the NHTSA API to fetch vehicle details.
5. Customer states which spare part(s) they need — either right after onboarding, or as their very first message if they lead with it.
6. System matches requested parts against inventory for their vehicle.
7. Matching parts are sent back to the customer.
8. Customer selects the part(s) they want.
9. System sends a proforma (price preview) for confirmation.
10. Customer confirms → system presents payment method options.
11. Customer pays via the selected method and uploads a payment screenshot as proof.
12. Admin panel receives the order + payment proof; admin approves or rejects.
13. **Approved** → real invoice generated via Primavera and sent to the customer over WhatsApp, plus an order confirmation message. **Rejected** → customer gets a message that the order was rejected and payment will be refunded within 3–5 business days.
14. Staff/admin get notified of the order.

### Decisions made (2026-07-02)

- **Onboarding is a single merged flow.** Registration (name→NIF→address) and vehicle ID (VIN / document photo / manual entry) become one step machine for new customers, not the two independent ones that exist today. Vehicle ID no longer happens "whenever a VIN shows up later" — it's part of onboarding. ✅ **Implemented 2026-07-02.**
- **Image routing becomes state-aware.** Today *any* image is treated as a payment proof (see CLAUDE.md "message pipeline"), which would misroute a vehicle document sent during onboarding. Fix: route incoming images by the customer's current conversation state (awaiting vehicle ID → vehicle document; awaiting payment proof → payment proof) before wiring Claude Vision into the webhook. Wiring Vision in without this fix first will cause vehicle documents to be swallowed as payment proofs. ✅ **Implemented 2026-07-02**, alongside wiring Claude Vision itself.
- **No refund tracking.** Rejection sends a message-only "refunded within 3–5 business days" notice; staff handle the actual refund manually outside the system (consistent with payment gateway integration being out of scope per the SOW). No new order status added for this now — revisit only if staff lose track of pending refunds in practice.
- **Staff/admin notification stays WhatsApp-only** (no email — no email-sending capability exists in this codebase today), but the **trigger point moves earlier**: fire when the order is created (proforma sent), not only when a payment proof lands / presential payment is chosen as it does today. Still **not implemented**.

---

## 1. Infrastructure & Environment Setup

| Item | Status | Notes |
|---|---|---|
| Node/Express/TypeScript project structure | ✅ | `src/` organized into controllers, services, models, routes, middlewares, validations |
| Dependency & config validation on boot | ✅ | `src/config/config.ts` throws on missing required env vars |
| PostgreSQL connection pooling | ✅ | `src/config/db.ts` (`pg.Pool`) |
| Redis session store with fallback | ✅ | `src/services/session.service.ts` falls back to in-memory cache if Redis is unreachable |
| Database schema in this repo | ✅ | `db/schema.sql` (English identifiers) + `db/seed.sql`, applied via `npm run db:migrate` / `db:seed` (2026-07-02) |
| `.env.example` | ✅ | Added 2026-07-02, matches `config.ts` |
| Staging/production deployment config | ❌ | Not started |

---

## 2. AI Agent & Session Management

| Item | Status | Notes |
|---|---|---|
| Claude API integration (conversational agent) | ✅ | Working end-to-end in `whatsapp.controller.ts` (`processarAgenteConversa`) |
| Structured action parsing (search / confirm / handoff) | ✅ | `executarAccaoEstruturada` handles `pesquisar`, `confirmar_pedido`, `transferir_humano` |
| Redis-backed conversation history | ✅ | 20-message rolling window, 4h TTL |
| Duplicate AI logic | 🟡 | `ai.service.ts` has a clean `callAIAgent()` implementation that is **never called** — `whatsapp.controller.ts` has its own inline copy of the system prompt and Claude call, on a *different* model version. Needs consolidation to avoid prompt drift. |
| Claude Vision document extraction | ✅ | `extractDataWithClaudeVision` (`ai.service.ts`) is now wired into the webhook via `processVehicleDocument` in `whatsapp.controller.ts`, gated by state-aware image routing (2026-07-02). |
| CRM auto-registration & returning customer recognition | ✅ | See section 3 |

---

## 3. CRM & Customer Memory

| Item | Status | Notes |
|---|---|---|
| Automatic customer pre-registration on first contact | ✅ | `crm.model.ts` + `processarRegistoCRM` |
| Returning customer recognition | ✅ | `obterEActualizarCliente` updates last-contact + contact count |
| Guided registration flow (nome → NIF → morada → veículo) | ✅ | Full merged onboarding step machine in `whatsapp.controller.ts`, `registration_status` only reaches `complete` once vehicle ID also finishes (2026-07-02) |
| Customer segmentation queries | ✅ | `obterClientesPorSegmento` — 8 segments (inactive, diesel owners, Luanda, frequent buyers, no orders, Toyota owners, new in 7 days, all) |
| CRM stats aggregation | ✅ | `obterEstatisticasCRM` |
| Campaign send tracking | ✅ | `registarCampanhaEnviada` / `campanhas_enviadas` table |
| Campaign send **execution** (actually messaging a segment) | ❌ | No controller/route triggers a segment broadcast — the model layer supports it, nothing calls it |
| CRM dashboard UI (admin panel) | ❌ | Admin panel only shows orders + upload; no customer/segment view |

---

## 4. Vehicle Identification & Document Processing

| Item | Status | Notes |
|---|---|---|
| VIN format detection | ✅ | `vin.service.ts` (`isVIN`) |
| VIN decoding via NHTSA API | ✅ | `descodificarVIN`, with PT-AO fuel-type translation |
| VIN → vehicle session save | ✅ | `salvarSessaoViatura` |
| Manual vehicle collection fallback (marca → modelo → ano → nº motor) | ✅ | Full step machine in `whatsapp.controller.ts`, now also part of merged onboarding |
| Vehicle confirmation (Sim/Não buttons) | ✅ | `processVehicleConfirmation` — also finalizes onboarding when reached mid-registration |
| Claude Vision document reader (livrete/Título do Veículo) | ✅ | `processVehicleDocument` in `whatsapp.controller.ts` (2026-07-02) — downloads the image, calls `extractDataWithClaudeVision`, cross-checks any legible VIN against NHTSA, then reuses the Sim/Não confirmation flow |
| Document confirmation flow | ✅ | Ported from the old prototype's `documento-viatura.js`, reusing the existing VIN confirmation buttons instead of a separate flow |

---

## 5. WhatsApp Commerce Integration

| Item | Status | Notes |
|---|---|---|
| Meta webhook verification (GET) | ✅ | `verificarWebhook` |
| Meta webhook message intake (POST) | ✅ | `receberMensagemWebhook`, responds 200 immediately per Meta's 5s rule |
| Text message sending | ✅ | `whatsapp.service.ts` |
| Interactive button messages | ✅ | `enviarMensagemComBotoes` |
| Message routing priority chain (CRM → media → manual collection → VIN → confirmation → payment state → AI) | ✅ | `processarFluxoMensagem` — well-structured priority pipeline |
| PDF document sending (proforma/invoice) | ✅ | Media upload + document message, `pdf.service.ts` |
| Supplier delivery notification | ✅ | `notificarFornecedorEntrega` in `payment.service.ts` |
| Staff notification on payment proof / presential payment | ✅ | via `TELEFONE_FUNCIONARIO_REDE_PECAS` |

---

## 6. Inventory Aggregation & CSV/XLS Import

| Item | Status | Notes |
|---|---|---|
| Unified inventory table with full-text search | ✅ | `pecas` table (in old schema.sql — not yet in this repo), Portuguese `tsvector`, GIN index |
| Compatibility matching (marca/modelo/ano) | ✅ | `buscarPecasNoInventario` join across `pecas` → `compatibilidades` → `veiculos` |
| Price-ordered results, top 5 | ✅ | |
| Batch upsert import (insert/update/deactivate missing SKUs) | ✅ | `importarPecasBatch` — transactional, logs to `logs_sincronizacao` |
| CSV/XLS/XLSX file parsing | 🟡 | Currently done **client-side only** in the admin panel (`rede-pecas-admin/src/App.tsx` uses the `xlsx` npm package in the browser, then POSTs parsed JSON). The `xlsx` package is also installed in this backend but **never used** — no server-side upload endpoint exists yet. |
| Import history visibility | 🟡 | Logged to `logs_sincronizacao` table but no API route reads it back — admin panel can't display import history |
| Waitlist for out-of-stock parts | ✅ | `registarPedidoPendente` / `pedidos_pendentes` |

---

## 7. Payment Approval & Invoice Workflow

| Item | Status | Notes |
|---|---|---|
| Payment method selection (buttons) | ✅ | 5 methods: transferência, depósito, Multicaixa Express, TPA móvel, dinheiro |
| Payment sub-type routing (bank/presencial) | ✅ | `processarSubtipoMetodo` |
| Payment proof upload (image/PDF) | ✅ | `processarComprovativo` |
| Staff approval panel API | ✅ | `admin.controller.ts` — approve/reject endpoints |
| Proforma PDF generation | ✅ | `pdf.service.ts` (`gerarProformaPDF`) — branded A4 layout |
| Official invoice via Primavera API | 🟡 | Real integration coded, but **falls back to a mock PDF** when `PRIMAVERA_API_TOKEN` isn't set — correct defensive design, just needs real Primavera credentials to go live |
| Invoice delivery via WhatsApp | ✅ | `enviarFacturaDefinitivaWhatsApp` |
| Admin approval panel UI | ✅ | `rede-pecas-admin` — login, pending/approved lists, approve/reject buttons |

---

## Cross-cutting gaps (not tied to one feature area)

- **No automated tests** anywhere in the backend or admin panel.
- Admin auth is a single shared password (no per-employee accounts); order approval hardcodes a mock employee ID.
- Explicitly out of scope per the SOW and correctly *not* touched: Shopify/Odoo/WooCommerce sync, the standalone `sync-agent/` supplier installer, and any payment gateway integration — these exist only in the old prototype repo and should stay there.

---

## Suggested next steps (in order)

1. ~~Port `schema.sql` into this repo~~ ✅ Done 2026-07-02 (`db/schema.sql` + `db:migrate`).
2. ~~Add `.env.example` matching `config.ts`~~ ✅ Done 2026-07-02.
3. Move placeholder payment details (IBAN, account, Multicaixa number in `payment.service.ts` / `pdf.service.ts`) and the default admin password fallback into env vars before production.
4. ~~Make image routing in `processMessageFlow` state-aware~~ ✅ Done 2026-07-02.
5. ~~Wire Claude Vision document reading into the WhatsApp webhook flow~~ ✅ Done 2026-07-02 (`processVehicleDocument`).
6. ~~Merge the registration and manual-vehicle-collection step machines into a single new-customer onboarding flow~~ ✅ Done 2026-07-02.
7. Move the staff/admin WhatsApp notification trigger from payment-proof/presential-payment to order creation (proforma sent), per the 2026-07-02 workflow decisions.
8. Consolidate the duplicated AI agent logic into `ai.service.ts`.
9. Add a server-side multipart upload endpoint for CSV/XLS/XLSX import (backend currently has the `xlsx` dependency installed but unused).
10. Add a GET endpoint to expose `sync_logs` so the admin panel can show import history.
11. Manually verify the three onboarding vehicle-ID paths end to end against a real/sandbox WhatsApp number (VIN typed, document photo via Vision, manual fallback) — no automated test suite exists in this repo yet.
