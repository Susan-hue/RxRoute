# RxRoute

WhatsApp-native prescription routing and pharmacy locator.

A patient photographs a handwritten prescription and shares their location over WhatsApp. Gemini 2.5 Flash validates the document and extracts the medications, a PostGIS query finds the 5 nearest pharmacies, and all 5 are messaged at once. The first to reply `YES-<REF>` wins the order.

**Stack:** Node.js / Express · Supabase (PostgreSQL + PostGIS) · Twilio WhatsApp · Google Gemini 2.5 Flash

---

## Quick start

```bash
npm install
cp .env.example .env          # then fill in your credentials

# Apply the schema + seed data (needs DATABASE_URL in .env),
# or paste db/schema.sql and db/seed.sql into the Supabase SQL Editor.
npm run db:push
npm run db:seed
npm run db:verify             # proves the backend is talking to a real database

npm run dev
```

Expose the webhook and point Twilio at it:

```bash
ngrok http 3000
# Twilio Console → Messaging → WhatsApp Sandbox
#   "When a message comes in" → https://<id>.ngrok-free.app/webhook/whatsapp  (POST)
```

Then set `PUBLIC_BASE_URL` to that ngrok URL and `VALIDATE_TWILIO_SIGNATURE=true`.

To receive broadcasts yourself, change one seeded pharmacy's number to your own WhatsApp number (joined to the Sandbox):

```bash
curl -X PATCH localhost:3000/api/pharmacies/<id> \
  -H 'content-type: application/json' \
  -d '{"name":"My Test Pharmacy"}'
# or re-run upsert_pharmacy with your number in db/seed.sql
```

---

## Architecture

```
POST /webhook/whatsapp
        │
        ├── register_inbound_message()      idempotency gate (Twilio retries)
        │
        ├── location pin?  ──► upsert_patient_location()   ──► resume any parked photo
        │
        ├── "YES-RX0001"?  ──► claim_prescription_request()  ← row lock, one winner
        │
        └── photo?
              ├── mediaService    download from Twilio (Basic auth → CDN redirect)
              ├── aiService       Gemini 2.5 Flash, structured JSON output
              ├── create_prescription_request()            status = pending
              ├── find_nearby_pharmacies(lat, lon, 5000)   GIST index, LIMIT 5
              ├── prescription_broadcasts                  ledger written BEFORE sending
              └── Twilio fan-out to all 5 pharmacies
```

Module layout follows the PRD:

| Path | Role |
|---|---|
| `config/supabase.js` | Supabase client (service role) + connection verification |
| `config/twilio.js` | Twilio SDK + credential check |
| `config/env.js` | Validated configuration; the process will not boot without it |
| `services/aiService.js` | Gemini 2.5 Flash vision wrapper |
| `services/geoService.js` | PostGIS query helpers |
| `services/mediaService.js` | Twilio media download + type/size guards |
| `services/messagingService.js` | Outbound WhatsApp + all message templates |
| `services/prescriptionService.js` | The pipeline: ingest → verify → match → broadcast → claim |
| `services/sessionService.js` | Conversational state (location pins, parked photos) |
| `controllers/whatsappController.js` | Webhook router and state machine |
| `db/schema.sql` | Tables, PostGIS functions, RLS, grants |
| `db/seed.sql` | 10 Lagos pharmacies with real coordinates |

---

## API

All `/api/*` routes require `x-api-key: $API_KEY` (or `Authorization: Bearer`). Optional in development; **mandatory in production** — these endpoints expose patient phone numbers and prescription contents.

### Pharmacies

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/pharmacies` | `?active=true&search=&limit=&offset=` |
| `GET` | `/api/pharmacies/nearby` | `?lat=&lng=&radius=&limit=` — live PostGIS query |
| `GET` | `/api/pharmacies/:id` | |
| `POST` | `/api/pharmacies` | Upserts on `phone_number` |
| `POST` | `/api/pharmacies/bulk` | `{ "pharmacies": [...] }` |
| `PATCH` | `/api/pharmacies/:id` | `latitude`/`longitude` must be sent together |
| `DELETE` | `/api/pharmacies/:id` | Deactivates; `?hard=true` deletes (refused if it has fulfilment history) |

### Prescriptions

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/prescriptions` | `?status=&patient_phone=&limit=&offset=` |
| `GET` | `/api/prescriptions/:idOrCode` | Accepts a UUID **or** a short code (`RX0001`) |
| `GET` | `/api/prescriptions/:idOrCode/broadcasts` | Per-pharmacy fan-out with delivery status |
| `POST` | `/api/prescriptions` | Runs the full pipeline — same code path as the webhook |
| `POST` | `/api/prescriptions/:idOrCode/claim` | `409` if already claimed |
| `POST` | `/api/prescriptions/:idOrCode/rebroadcast` | Re-sends a pending request; reuses the stored AI extraction |
| `POST` | `/api/prescriptions/expire-stale` | Ages out unclaimed requests |

### Dashboard & health

`GET /api/stats` · `GET /api/activity` · `GET /health` · `GET /health/deep` (round-trips all four dependencies, `503` if any is down)

### Examples

```bash
K='-H x-api-key:your-key'

# Nearest pharmacies to Yaba
curl $K "localhost:3000/api/pharmacies/nearby?lat=6.5095&lng=3.3711&radius=5000"

# Run a prescription through the real pipeline
curl -X POST $K -H 'content-type: application/json' localhost:3000/api/prescriptions \
  -d '{"patient_phone":"+2348012345678","media_url":"https://.../rx.jpg",
       "latitude":6.5095,"longitude":3.3711}'

# Claim it
curl -X POST $K -H 'content-type: application/json' \
  localhost:3000/api/prescriptions/RX0001/claim \
  -d '{"pharmacy_phone":"+2348000000001"}'
```

---

## WhatsApp commands

**Patients** — send a location pin, then a photo of the prescription (either order works; a photo sent first is parked and processed automatically when the pin arrives).

**Pharmacies** — reply `YES-<REF>` to claim a broadcast order.

**Anyone** — `STATUS <REF>` for a request's state, `HELP` for instructions.

---

## Design notes

Choices worth knowing about, and why.

**Short reference codes.** Pharmacies retype the reference on a phone keypad, so a UUID is unusable and a truncated UUID risks collisions. References come from a sequence, Crockford-base32 encoded (no `I`/`L`/`O`/`U`, nothing that reads as `1` or `0`): `RX0001`, `RX0002`, … Uniqueness is guaranteed by the sequence, not by luck — verified collision-free across 2,000+ rows.

**The claim is decided in Postgres, not in Node.** `claim_prescription_request()` takes a `SELECT … FOR UPDATE` row lock. Two pharmacies replying in the same millisecond cannot both win: the loser's transaction blocks, re-reads `status = 'claimed'`, and is told who won. Verified with 5 simultaneous connections claiming one reference — exactly one `claimed`, four `already_claimed`.

**The broadcast ledger is written before the first message is sent.** A fast pharmacy can reply while we are still messaging the other four, and the claim check reads that ledger to authorise. Writing it afterwards would let a legitimate claim be rejected.

**Geography goes through RPCs.** `GEOGRAPHY` columns can't be written over the PostgREST JSON interface, so every location write calls a Postgres function, and reads come from views that project `ST_Y`/`ST_X` as plain floats. The views use `security_invoker = true` so RLS is evaluated as the caller rather than the view owner.

**The webhook acknowledges immediately.** Twilio abandons a webhook after 15 seconds; a media download plus a Gemini call plus five sends routinely exceeds that. The webhook returns empty TwiML and continues in the background, replying over the REST API. Set `WEBHOOK_ASYNC=false` to process inline when testing with curl.

**Twilio retries are idempotent.** `MessageSid` is unique in `whatsapp_messages`; inserting it first means a retry can't re-run AI vision or re-broadcast the same prescription.

**Failures are recorded, not swallowed.** An unreadable photo is stored with `status = 'failed'` and the AI's reason, so rejections are auditable rather than invisible. `sendWhatsapp` never throws — one failed send out of five must not abort the other four — but every outcome is written to the ledger with its Twilio SID or error.

**National phone formats are rejected, not guessed.** `0803 111 2233` has no country code; inferring one would silently create a pharmacy Twilio can never deliver to. The API returns `400` and asks for international format.

**Pharmacies deactivate rather than delete.** A pharmacy is referenced by `prescription_requests.claimed_by_pharmacy_id`; hard deletion is refused once it has fulfilment history.

### Deviations from the PRD

Three, all additive:

1. **`find_nearby_pharmacies` qualifies its columns** (`p.id`, `p.name`, …). The names in `RETURNS TABLE` are in scope inside the function body, so the PRD's unqualified `SELECT id, name …` fails with `column reference "id" is ambiguous`. Signature and behaviour are otherwise exactly as specified. An optional 4th parameter `max_results` defaults to 5, so 3-argument calls still work.

2. **Extra tables:** `prescription_broadcasts` (makes claims verifiable and delivery traceable), `patient_sessions` (the pin/photo ordering problem), `whatsapp_messages` (idempotency + audit). The PRD's two tables are unchanged apart from additive columns (`short_code`, `claimed_at`, `failure_reason`, `ai_raw_response`, `broadcast_count`).

3. **`db/seed.sql` has 10 pharmacies, not 5.** `find_nearby_pharmacies` has `LIMIT 5` — with only 5 rows you can never observe that it returns the *nearest* five rather than simply all of them. Four sit within 5 km of the Yaba demo pin; the rest span Ikeja, Ikoyi, Victoria Island and Lekki so radius behaviour is visible. Numbers are in the unassigned `+2348000000xxx` block so a stray test broadcast cannot reach a real person.

---

## Verification

The schema and API were exercised against real PostgreSQL 16 + PostGIS 3.4 and a real PostgREST instance (not mocks) during development:

- `db/schema.sql` applies cleanly and is idempotent across repeated runs.
- The geo query uses the GIST index (`Index Scan using pharmacies_geo_index`), not a sequential scan.
- 5 concurrent claims on one reference → exactly 1 winner, 4 `already_claimed`.
- 44 HTTP route assertions covering auth, validation, success, and error paths.
- Media guards: PDFs, videos, oversized and empty payloads all rejected with actionable messages.

`npm run db:verify` reproduces the database half of this against your own Supabase project.

Not covered without live credentials: an end-to-end Gemini vision call on a real prescription photo, and live Twilio delivery. The Gemini request path is confirmed well-formed — with a placeholder key the API returns `API_KEY_INVALID`, meaning the request reached Google and was parsed. Run `GET /health/deep` once your keys are in place to confirm all four dependencies.

---

## Environment

See `.env.example`. Required: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_NUMBER`, `GEMINI_API_KEY`.

Notable optional settings:

| Variable | Default | Purpose |
|---|---|---|
| `SEARCH_RADIUS_METERS` | `5000` | Initial search radius; widens to 2× then 4× if nothing is found |
| `MAX_PHARMACIES_PER_BROADCAST` | `5` | Fan-out size |
| `CLAIM_REQUIRES_BROADCAST` | `true` | Only pharmacies the request was sent to may claim it |
| `WEBHOOK_ASYNC` | `true` | Ack Twilio immediately, process in background |
| `VALIDATE_TWILIO_SIGNATURE` | `false` | Turn on for anything deployed; needs `PUBLIC_BASE_URL` |
| `API_KEY` | — | Guards `/api/*`; required in production |

> `SUPABASE_SERVICE_ROLE_KEY` bypasses Row Level Security. Keep it server-side — never ship it to a browser or mobile client.
