# Rede Peças — Progress Report

## Update — 2026-07-07 (uniform response envelope, refresh token, humanized validation errors)

- **Every admin API response now shares one envelope**: success → `{ success: true, message, code, data, [accessToken], [refreshToken], meta: { timestamp } }`; error → `{ success: false, message, code, data: null, meta: { timestamp } }`. Deliberately **not** a shared response-builder function — each controller (`auth`, `order`, `product`) constructs its own `res.json({...})` literally; only the shape is a shared convention. `errorHandler`/`errorConverter` (`src/middlewares/error.ts`) produce the error side for every thrown `ApiError`; `order.controller.ts` and `product.controller.ts` were migrated from manual try/catch + inline `res.status(500).json({error})` to `catchAsync`/`ApiError` so they funnel through it too, matching what `CLAUDE.md` already documented but wasn't actually followed everywhere.
- **Stack traces are never sent to the client** (dev or prod) — only logged server-side via `logger.error`. Previously `config.env === 'development'` included the full stack in the JSON body.
- **Joi validation errors are humanized** (`src/middlewares/validate.ts`): raw messages like `"password" is required` or `"newPassword" length must be at least 8 characters long` used to be sent verbatim (with a stack trace attached) — now become `Password is required` / `New Password length must be at least 8 characters long` (camelCase/snake_case field names get spaced + capitalized before Joi's phrasing). Found via the exact bug report: a missing `password` on login was returning raw middleware internals to the client.
- **Refresh token added** (stateless, per your call — no DB-tracked session/revocation for now). `POST /admin/login` now returns both `accessToken` (1h) and `refreshToken` (30d, `JWT_REFRESH_EXPIRATION_DAYS` env var, default 30) — the refresh token carries `type: 'refresh'` in its JWT payload, and `authMiddleware` rejects it if used as a bearer token on any protected route other than the new `POST /admin/refresh`, which exchanges it for a fresh `accessToken`. No rotation — the refresh token itself stays valid until its own expiry.
- **Postman collection trimmed and updated to match** (`postman/Rede-Pecas-API.postman_collection.json`, 30 → 19 requests): removed the standalone "negative path" requests (wrong password, missing token, invalid body, etc.) — those are exercised by editing the body/headers of the real request and resending, not separate collection items. Added a "Refresh Token" request. Every test script updated for the new envelope (assertions now check `json.success`/`json.data.*` instead of top-level fields). Re-verified end-to-end with `newman`: 19/19 requests, 30/30 assertions passing against a live server.

## Update — 2026-07-07 (admin accounts + password reset, multi-supplier CSV import)

- **Admin auth moved from a single shared `ADMIN_PASSWORD` to individual accounts.** New `admin_users` table (`db/schema.sql`, seeded with a dev login in `db/seed.sql` — `admin@redepecas.ao` / `admin123`), `adminUser.model.ts`, `adminAuth.service.ts` (bcryptjs hashing, already a dependency but previously unused). `POST /admin/login` now takes `{ email, password }`; JWT payload is `{ id, email, role }` instead of just `{ role: 'admin' }`. `config.admin.password`/`ADMIN_PASSWORD` removed entirely.
- **New endpoints**: `GET/PATCH /admin/profile` (view/update name+email), `POST /admin/change/password` (requires current password), `POST /admin/forgot/password` + `POST /admin/reset/password` (6-digit code, 10-min expiry, bcrypt-hashed at rest, delivered via **WhatsApp** to the admin's own `phone` column — no email/SMTP service exists in this project, so the existing WhatsApp integration is reused instead of adding one). All route segments use `/` nesting, not hyphens (`inventory/import/file` too — renamed from the initial `import-file`). `forgot/password` always responds identically regardless of whether the email matched an account (including when the WhatsApp send itself fails — caught and logged, not surfaced) so the endpoint can't be used to enumerate admin emails; found and fixed during manual testing, where a bad dev phone number's send failure was initially leaking which emails existed.
- **Auth controller rewritten around `catchAsync`/`ApiError`** (previously manual try/catch + inline `res.status().json()`, inconsistent with what `CLAUDE.md` documents) — new `src/validations/auth.validation.ts`, `login` schema moved out of `admin.validation.ts`.
- **CSV/XLSX product import now supports multiple suppliers in one file.** `supplier.model.ts`'s `importProductsBatch` resolves a supplier per row (`supplierId`, or `supplierName`+`supplierNif`+`supplierProvince` — cached per name within the call so a repeated new supplier name isn't created twice) instead of assuming one supplier for the whole request; falls back to a request-level default supplier for rows that don't specify their own (preserves the original single-supplier-per-file usage unchanged). Rows are grouped by resolved supplier so the "deactivate products missing from this import" step and `sync_logs` entries stay correctly scoped per supplier, not the whole file. `product.controller.ts`'s CSV/XLSX column mapping gained `supplier`/`supplier_nif`/`supplier_province` header aliases. Verified end-to-end against the running dev server: a 3-row file with 2 distinct suppliers correctly created both suppliers, attributed each product to the right one, and logged two separate `sync_logs` rows.

## Update — 2026-07-07 (multi-vehicle support, rejected-VIN wizard consistency)

- **A customer can now have more than one confirmed vehicle.** `vehicles.id` is the new primary key (`db/schema.sql` migration, idempotent, applied to the dev DB) — `phone` is a plain FK column, no longer unique. `vehicle.model.ts` rewritten around this: `getCustomerVehicles` (plural, for search-time selection), `getMostRecentVehicle` (for the save→confirm window, unambiguous even with other vehicles on file), `saveVehicleSession`/`startManualCollection`/`updateManualCollection`/`clearVehicleSession` now operate by row `id` rather than assuming one row per phone.
- **"Add another vehicle"**: a "➕ Outro carro"/"➕ Add vehicle" button is now offered alongside every "what part do you need" message (`vehicleService.startAddVehicleFlow`, triggered via the button or the phrase typed free-text — `isAddVehicleRequest`). Re-runs the same VIN/photo/manual choice; `saveVehicleSession` always inserts a new row unless completing a specific in-progress one, so existing vehicles are untouched.
- **Vehicle picker for multi-vehicle searches**: when a search is about to happen and the customer has 2+ vehicles, `sendAskPartPrompt` now asks "which vehicle is this for?" (numbered list) before inviting the part search; `ai.service.ts` uses the resolved choice (`sessionService.getChosenVehicle`) instead of guessing. Asks fresh each time an invitation cycle starts (not just once per session).
- **Bug fixed: rejecting a decoded vehicle ("Não") used to delete *all* of a customer's vehicles** (`clearVehicleSession` deleted by `phone`, which was fine when phone⇄vehicle was 1:1 but would have wiped every other confirmed vehicle once multi-vehicle landed). Now deletes only the specific just-rejected row by `id`.
- **Bug fixed: rejecting a decoded vehicle sent inconsistent follow-ups** — a first-time customer got the step-by-step manual wizard, but a returning customer got a one-shot "type make, model, and year together" prompt that nothing downstream actually parsed, wasting a round-trip. Both cases now get the same step-by-step wizard; the now-dead `rejectedFreeText` message was removed from `i18n/messages.ts` (both locales).
- **AI call no longer retries blindly after a failure.** `sessionService.clearPartPromptSent` is called only in `ai.service.ts`'s catch block (not on success) — so after an Anthropic error, the customer's next message re-triggers the deterministic "what part do you need" prompt instead of silently retrying (and failing again) on every subsequent message. Left alone on success, since the AI still owns the conversation then (pending search options, order confirmation).

## Update — 2026-07-07 (registration/vehicle-ID split, AI-call gating, routes re-versioned)

- **Registration and vehicle ID un-merged back into two independent state machines.** The 2026-07-02 merge (`customers.registration_status = 'awaiting_vehicle_id'` as the bridge value) made it impossible to resume "just the vehicle" for a returning customer whose vehicle session expired without re-touching profile status. `registration_status` now only covers the profile (`awaiting_name → awaiting_nif → awaiting_nif_number → awaiting_address → complete`); vehicle-ID readiness (`needsVehicleId` in `whatsapp.controller.ts`) is derived live from the `vehicles` table via new `vehicleService.hasVehicleOnFile`. `customer.service.ts`'s `processCRMRegistration` renamed to `processCustomerRegistration`. One-time data migration in `db/schema.sql` (`awaiting_vehicle_id` → `complete`) applied to the dev DB. The "first vehicle ever" vs "returning, vehicle session just expired" distinction (which message to send) now keys off `customers.registered_at IS NULL` instead of the removed status value.
- **The AI agent is now gated behind an explicit invitation.** New `sessionService.wasPartPromptSent`/`markPartPromptSent` (Redis flag, 4h TTL) is set at every point the bot asks "what part do you need" (onboarding/manual-collection completion, vehicle confirmation, returning-customer greeting). The conversational Claude call in `processMessageFlow` only fires once that flag is set — otherwise the deterministic prompt is (re-)sent instead, avoiding an Anthropic call (and its failure mode) for stray chatter. A `GREETING_PATTERN` (PT/EN) always forces the deterministic prompt even after the flag is set, so a later "Hi"/"Hey" doesn't get treated as a product name.
- **Staff WhatsApp alert on AI failure disabled** (commented out in `ai.service.ts`, not deleted) — `STAFF_PHONE_NUMBER` isn't on the WhatsApp test allow-list yet, so it was erroring on every AI failure instead of helping.
- **NHTSA API URL moved to config/env** (`NHTSA_API_URL`, `config.nhtsa.apiUrl`) instead of a hardcoded constant in `vehicle.service.ts`.
- **Routes re-versioned back to `routes/v1/`** (`index.ts`, `auth.route.ts`, `order.route.ts`, `product.route.ts`, `whatsapp.route.ts`), matching the `development` branch's convention and reversing the flattening from the 2026-07-06 entry below. `routes/index.ts` removed entirely — `app.ts` mounts `routes/v1/index.ts` directly under `/v1`. External URLs unchanged (`/v1/admin/...`, `/v1/webhook/whatsapp` — verified via `npm run build`).

## Update — 2026-07-06 (controller/service domain-split reorganization)

- **`whatsapp.controller.ts` slimmed from 804 lines / 17 functions to 3** (`verifyWebhook`, `receiveWebhookMessage`, `processMessageFlow`). Every domain-specific handler moved into a per-domain service — the controller now has zero model imports and no `Anthropic` SDK import.
- **New services**: `customer.service.ts` (registration/CRM — `getOrCreateCustomer`, `processCRMRegistration`, `sendResumeRegistrationPrompt`, `completeOnboardingIfNeeded`), `product.service.ts` (`searchAndRespond`, `processWaitlistOptIn`, `notifyWaitlistedCustomers` — absorbed from the now-deleted `inventory.service.ts`).
- **`vin.service.ts` renamed to `vehicle.service.ts`**, absorbing all 5 vehicle-identification handlers (`processVehicleIdOptionChoice`, `processManualCollectionStep`, `processVIN`, `processVehicleDocument`, `processVehicleConfirmation`) alongside the existing VIN/NHTSA logic.
- **`ai.service.ts`** absorbed `processAIConversation`/`callAnthropic`/`executeStructuredAction`/`tryParseJSON` from the controller (search branch now delegates to `productService.searchAndRespond`), and the dead `callAIAgent` + its orphaned `SYSTEM_PROMPT` constant were deleted (zero callers anywhere).
- **`payment.service.ts`** gained one addition, `getPendingPaymentOrder(phone)`, so the controller doesn't need to import `order.model.ts` directly.
- **`admin.controller.ts`**: its one raw `db.query` bypass (in `rejectOrderHandler`) now goes through the existing `getOrderByNumber` model function instead.
- **Routes flattened**: `routes/v1/` deleted; `whatsapp.route.ts`/`admin.route.ts` moved to `routes/` directly; the `/v1` prefix now binds explicitly per-route inside `routes/index.ts` (`router.use('/v1/webhook/whatsapp', ...)`, `router.use('/v1/admin', ...)`) instead of in `app.ts`. External URLs unchanged — verified via live HTTP smoke test against the running dev server (webhook verify handshake, admin login, inventory import-file all resolve identically).
- No circular imports — the dependency graph was explicitly checked; `ai.service.ts` imports `getCustomerVehicle` directly from `vehicle.model.ts` rather than through `vehicle.service.ts` to avoid a 2-node cycle.
- Pure refactor — no behavior change intended; `npm run build`/`npm run lint` clean throughout, verified incrementally with `npx tsc --noEmit` after each step.

## Update — 2026-07-06 (database schema consolidation, 14 → 8 tables)

- **Vehicle identification merged into one table.** `vehicle_sessions` + `manual_vehicle_collections` are now a single `vehicles` table, keyed by `phone` (FK to `customers`), covering all 3 identification paths (VIN, manual entry, document photo). A `status` column distinguishes a confirmed vehicle (4h TTL) from an in-progress manual wizard step (30-min TTL) on the same row. All model function names/signatures in `vehicle.model.ts` stayed identical — no changes needed in `whatsapp.controller.ts` for the merge itself.
- **NHTSA VIN cache is now actually wired up.** Renamed `vin_cache` → `nhtsa_vehicles`; `decodeVIN` (`vin.service.ts`) now checks the cache before hitting the live NHTSA API and saves successful decodes — previously this table existed but was 100% dead code (every VIN lookup always hit the live API).
- **Dropped entirely (zero code references, or deliberately descoped):** `categories` (+ `products.category_id`), `campaign_sends` (+ the unused `getCustomersBySegment`/`logCampaignSend`/`getCRMStats` in `customer.model.ts`), `waitlist_requests`, the static vehicle-compatibility catalog (formerly `vehicles`) and its `compatibilities` join table. Nothing in the app ever populated the compatibility catalog — `searchProductsInInventory` now does pure full-text search (`products.search_vector`); vehicle make/model/year from the conversation are chat-context only, no longer used to filter DB results.
- **Waitlist redesigned as `products.waitlist_phones TEXT[]`** instead of a separate table. The bot now actually saves a "notify me" opt-in (previously it asked the question and never captured the answer) via a new pending-offer flow in `session.service.ts`/`whatsapp.controller.ts`. `importProductsBatch` (`supplier.model.ts`) detects a quantity 0→positive transition per item and returns `restockNotifications`; a new `inventory.service.ts` sends the "back in stock" WhatsApp messages.
- **New server-side CSV/XLSX upload endpoint**: `POST /admin/inventory/import-file` (multipart, `multer`), parses the file with the previously-unused `xlsx` package, upserts suppliers (by id or by name/nif/province) + products via the existing `importProductsBatch`. Coexists with the original JSON-body `/admin/inventory/upload` — the admin frontend repo wasn't touched.
- Final table count: `customers`, `suppliers`, `products`, `orders`, `order_counters`, `sync_logs`, `vehicles` (new merged), `nhtsa_vehicles`.
- **Known gap, flagged not fixed:** `CLAUDE.md` and this file's earlier entries still reference the old table names (`vehicle_sessions`, `manual_vehicle_collections`) in prose — a documentation pass to update those is still pending.

## Update — 2026-07-06 (session-resume fix, AI failure fallback, NHTSA logging)

- **Stale mid-registration resume fixed.** A customer stuck at `awaiting_name`/`awaiting_nif`/`awaiting_address` whose session had gone cold no longer has their first message silently consumed as that step's answer (e.g. "Hi" being saved as their name). New `isNewSession`/`markSessionActive` in `session.service.ts` (Redis key `active:<phone>`, 4h TTL, decoupled from the AI conversation transcript) detect a stale resume and re-send the pending question instead via `sendResumeRegistrationPrompt`. Same fix applied to the `awaiting_vehicle_id` stage (re-shows the 3-option buttons on a stale resume instead of guessing from free text).
- **Replaced the flawed "greet once" check.** The earlier `getHistory(phone).length === 0` signal for the returning-customer greeting was wrong — a `complete` customer whose whole session was payment-flow messages (which never touch AI history either) would get re-greeted on every message. Now driven by the same `isNewSession` marker.
- **AI agent failures no longer go silent.** `processAIConversation` had no try/catch around the Anthropic call — a bad `ANTHROPIC_API_KEY` (or any downstream failure) propagated to the outer webhook handler, which only logs, leaving the customer with a greeting and then dead silence. Now catches, sends a generic "temporary instability" message to the customer, and alerts `STAFF_PHONE_NUMBER`.
- **NHTSA VIN-decode calls are now logged on success/no-match**, not just on exception — `[NHTSA] Decoded VIN ...` / `[NHTSA] No match for VIN ...` in `vin.service.ts`, covering both call sites (`processVIN` and `processVehicleDocument`).
- **Logger bug fixed:** `logger.error(msg, errorObject)` calls were silently dropping the error object — `logger.ts`'s `printf` only printed `level`/`message`. Now includes any extra metadata (e.g. Meta Graph API error bodies) in the console output.

## Update — 2026-07-06 (greeting, vehicle-ID buttons, button-reply parsing fix)

- **Critical webhook bug fixed:** the webhook only ever read `msg.text.body`, so every quick-reply button tap (`msg.type === 'interactive'`/`'button'`) produced `customerText = null` and was silently dropped. This affected every existing button flow (VIN confirm Sim/Não, document confirm, payment method selection, bank/in-person subtype) whenever a real customer tapped instead of typing. Now extracts `interactive.button_reply.title` / `button.text` too.
- **Also removed:** a leftover `TEMPORARY` debug line that sent a "bot is active" reply on every single inbound message, stacking on top of the real flow's own reply.
- **Returning-customer greeting added.** A customer whose `registration_status === 'complete'` now gets a short "welcome back" message — but only once per session, using the existing Redis conversation history (4h TTL) as the session boundary (empty history = new session). No schema change.
- **Vehicle-ID step is now 3 explicit buttons** (VIN / send photo / manual entry) instead of instructional text, sent right after the address step. Tapping VIN or photo just prompts what to send next (existing VIN-detection/image-routing stages pick it up); tapping manual starts the step machine directly.

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
