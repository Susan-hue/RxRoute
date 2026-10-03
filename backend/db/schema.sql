
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()


CREATE SEQUENCE IF NOT EXISTS prescription_ref_seq START WITH 1 INCREMENT BY 1;

CREATE OR REPLACE FUNCTION rxroute_encode_ref(n BIGINT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE STRICT
AS $$
DECLARE
    alphabet CONSTANT TEXT := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    encoded  TEXT := '';
    v        BIGINT := n;
BEGIN
    IF v < 0 THEN
        RAISE EXCEPTION 'rxroute_encode_ref: reference must be non-negative, got %', n;
    END IF;

    LOOP
        encoded := substr(alphabet, (v % 32)::int + 1, 1) || encoded;
        v := v / 32;
        EXIT WHEN v = 0;
    END LOOP;

    RETURN 'RX' || lpad(encoded, 4, '0');
END;
$$;


-- ---------------------------------------------------------------------------
-- 2. Pharmacies
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pharmacies (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          TEXT NOT NULL,
    phone_number  TEXT NOT NULL UNIQUE,              -- WhatsApp format: whatsapp:+2348012345678
    address       TEXT,
    location      GEOGRAPHY(POINT, 4326) NOT NULL,   -- (Longitude, Latitude)
    is_active     BOOLEAN DEFAULT TRUE,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS address    TEXT;
ALTER TABLE pharmacies ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Index for lightning-fast geospatial queries
CREATE INDEX IF NOT EXISTS pharmacies_geo_index ON pharmacies USING GIST(location);
CREATE INDEX IF NOT EXISTS pharmacies_active_index ON pharmacies (is_active) WHERE is_active;


-- ---------------------------------------------------------------------------
-- 3. Prescription requests
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS prescription_requests (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    short_code              TEXT NOT NULL UNIQUE
                                DEFAULT rxroute_encode_ref(nextval('prescription_ref_seq')),
    patient_phone           TEXT NOT NULL,
    media_url               TEXT NOT NULL,
    media_content_type      TEXT,
    extracted_drugs         JSONB DEFAULT '[]'::jsonb,
    ai_raw_response         JSONB,
    patient_location        GEOGRAPHY(POINT, 4326),
    status                  TEXT DEFAULT 'pending'
                                CHECK (status IN ('pending', 'claimed', 'expired', 'failed')),
    failure_reason          TEXT,
    claimed_by_pharmacy_id  UUID REFERENCES pharmacies(id),
    claimed_at              TIMESTAMPTZ,
    broadcast_count         INTEGER DEFAULT 0,
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    updated_at              TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE prescription_requests
    ADD COLUMN IF NOT EXISTS short_code TEXT
        DEFAULT rxroute_encode_ref(nextval('prescription_ref_seq'));
ALTER TABLE prescription_requests ADD COLUMN IF NOT EXISTS media_content_type TEXT;
ALTER TABLE prescription_requests ADD COLUMN IF NOT EXISTS ai_raw_response    JSONB;
ALTER TABLE prescription_requests ADD COLUMN IF NOT EXISTS failure_reason     TEXT;
ALTER TABLE prescription_requests ADD COLUMN IF NOT EXISTS claimed_at         TIMESTAMPTZ;
ALTER TABLE prescription_requests ADD COLUMN IF NOT EXISTS broadcast_count    INTEGER DEFAULT 0;
ALTER TABLE prescription_requests ADD COLUMN IF NOT EXISTS updated_at         TIMESTAMPTZ DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS prescription_requests_short_code_key
    ON prescription_requests (short_code);
CREATE INDEX IF NOT EXISTS prescription_requests_status_index
    ON prescription_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS prescription_requests_patient_index
    ON prescription_requests (patient_phone, created_at DESC);
CREATE INDEX IF NOT EXISTS prescription_requests_geo_index
    ON prescription_requests USING GIST(patient_location);


-- ---------------------------------------------------------------------------
-- 4. Broadcast ledger
--
-- One row per (request, pharmacy) the request was dispatched to. This is what
-- makes a claim verifiable: only a pharmacy that actually received the
-- broadcast can claim the order, and the Twilio message SID lets us trace
-- delivery after the fact.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS prescription_broadcasts (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id          UUID NOT NULL REFERENCES prescription_requests(id) ON DELETE CASCADE,
    pharmacy_id         UUID NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
    distance_meters     DOUBLE PRECISION,
    twilio_message_sid  TEXT,
    delivery_status     TEXT DEFAULT 'queued',
    error_message       TEXT,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (request_id, pharmacy_id)
);

CREATE INDEX IF NOT EXISTS prescription_broadcasts_request_index
    ON prescription_broadcasts (request_id);
CREATE INDEX IF NOT EXISTS prescription_broadcasts_sid_index
    ON prescription_broadcasts (twilio_message_sid);


-- ---------------------------------------------------------------------------
-- 5. Patient sessions
--
-- WhatsApp location pins and prescription photos arrive as separate messages in
-- either order. This table is the conversational state: the patient's last
-- known pin, plus any photo that landed before we had a location to route it
-- with (so it can be resumed the moment the pin arrives).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS patient_sessions (
    phone_number                TEXT PRIMARY KEY,
    location                    GEOGRAPHY(POINT, 4326),
    address_label               TEXT,
    pending_media_url           TEXT,
    pending_media_content_type  TEXT,
    last_inbound_at             TIMESTAMPTZ DEFAULT NOW(),
    location_updated_at         TIMESTAMPTZ,
    created_at                  TIMESTAMPTZ DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS patient_sessions_geo_index
    ON patient_sessions USING GIST(location);


-- ---------------------------------------------------------------------------
-- 6. Inbound message log
--
-- Twilio retries a webhook it believes failed, which would re-run AI vision and
-- re-broadcast the same prescription. MessageSid is unique, so inserting it
-- first turns the webhook into an idempotent operation.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_sid     TEXT NOT NULL UNIQUE,
    direction       TEXT NOT NULL DEFAULT 'inbound' CHECK (direction IN ('inbound', 'outbound')),
    from_number     TEXT,
    to_number       TEXT,
    body            TEXT,
    num_media       INTEGER DEFAULT 0,
    raw_payload     JSONB,
    processed_at    TIMESTAMPTZ,
    processing_note TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS whatsapp_messages_from_index
    ON whatsapp_messages (from_number, created_at DESC);


-- ---------------------------------------------------------------------------
-- 7. updated_at triggers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rxroute_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pharmacies_touch_updated_at ON pharmacies;
CREATE TRIGGER pharmacies_touch_updated_at
    BEFORE UPDATE ON pharmacies
    FOR EACH ROW EXECUTE FUNCTION rxroute_touch_updated_at();

DROP TRIGGER IF EXISTS prescription_requests_touch_updated_at ON prescription_requests;
CREATE TRIGGER prescription_requests_touch_updated_at
    BEFORE UPDATE ON prescription_requests
    FOR EACH ROW EXECUTE FUNCTION rxroute_touch_updated_at();

DROP TRIGGER IF EXISTS patient_sessions_touch_updated_at ON patient_sessions;
CREATE TRIGGER patient_sessions_touch_updated_at
    BEFORE UPDATE ON patient_sessions
    FOR EACH ROW EXECUTE FUNCTION rxroute_touch_updated_at();


-- ============================================================================
-- 8. PostGIS lookup: find the 5 nearest pharmacies
--
-- Note: every column is alias-qualified (p.id, p.name ...). The names declared
-- in RETURNS TABLE are in scope inside the function body, so an unqualified
-- `SELECT id, name ...` would fail with "column reference id is ambiguous".
-- ============================================================================
DROP FUNCTION IF EXISTS find_nearby_pharmacies(FLOAT, FLOAT, FLOAT);
DROP FUNCTION IF EXISTS find_nearby_pharmacies(FLOAT, FLOAT, FLOAT, INT);

CREATE OR REPLACE FUNCTION find_nearby_pharmacies(
    patient_lat          FLOAT,
    patient_lon          FLOAT,
    search_radius_meters FLOAT DEFAULT 5000,
    max_results          INT   DEFAULT 5
)
RETURNS TABLE (
    id              UUID,
    name            TEXT,
    phone_number    TEXT,
    distance_meters FLOAT
)
LANGUAGE sql
STABLE
AS $$
    SELECT
        p.id,
        p.name,
        p.phone_number,
        ST_Distance(
            p.location,
            ST_SetSRID(ST_MakePoint(patient_lon, patient_lat), 4326)::geography
        ) AS distance_meters
    FROM pharmacies p
    WHERE p.is_active = TRUE
      AND ST_DWithin(
            p.location,
            ST_SetSRID(ST_MakePoint(patient_lon, patient_lat), 4326)::geography,
            search_radius_meters
      )
    ORDER BY distance_meters ASC
    LIMIT GREATEST(max_results, 1);
$$;

-- Same query, with coordinates and address attached — used by the REST
-- endpoint that renders pharmacies on a map.
CREATE OR REPLACE FUNCTION find_nearby_pharmacies_detailed(
    patient_lat          FLOAT,
    patient_lon          FLOAT,
    search_radius_meters FLOAT DEFAULT 5000,
    max_results          INT   DEFAULT 5
)
RETURNS TABLE (
    id              UUID,
    name            TEXT,
    phone_number    TEXT,
    address         TEXT,
    latitude        DOUBLE PRECISION,
    longitude       DOUBLE PRECISION,
    distance_meters FLOAT
)
LANGUAGE sql
STABLE
AS $$
    SELECT
        p.id,
        p.name,
        p.phone_number,
        p.address,
        ST_Y(p.location::geometry) AS latitude,
        ST_X(p.location::geometry) AS longitude,
        ST_Distance(
            p.location,
            ST_SetSRID(ST_MakePoint(patient_lon, patient_lat), 4326)::geography
        ) AS distance_meters
    FROM pharmacies p
    WHERE p.is_active = TRUE
      AND ST_DWithin(
            p.location,
            ST_SetSRID(ST_MakePoint(patient_lon, patient_lat), 4326)::geography,
            search_radius_meters
      )
    ORDER BY distance_meters ASC
    LIMIT GREATEST(max_results, 1);
$$;


-- ============================================================================
-- 9. Write RPCs
--
-- GEOGRAPHY columns cannot be written through the PostgREST JSON interface, so
-- every insert/update that touches a location goes through one of these. They
-- return JSONB rather than RETURNS TABLE to sidestep the plpgsql
-- output-parameter / column-name collisions entirely.
-- ============================================================================

-- 9a. Create or update a pharmacy -------------------------------------------
CREATE OR REPLACE FUNCTION upsert_pharmacy(
    p_name         TEXT,
    p_phone_number TEXT,
    p_lat          DOUBLE PRECISION,
    p_lon          DOUBLE PRECISION,
    p_address      TEXT DEFAULT NULL,
    p_is_active    BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_row pharmacies;
BEGIN
    IF p_lat IS NULL OR p_lon IS NULL
       OR p_lat < -90 OR p_lat > 90 OR p_lon < -180 OR p_lon > 180 THEN
        RAISE EXCEPTION 'upsert_pharmacy: coordinates out of range (lat=%, lon=%)', p_lat, p_lon;
    END IF;

    INSERT INTO pharmacies (name, phone_number, address, location, is_active)
    VALUES (
        p_name,
        p_phone_number,
        p_address,
        ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography,
        COALESCE(p_is_active, TRUE)
    )
    ON CONFLICT (phone_number) DO UPDATE
        SET name      = EXCLUDED.name,
            address   = COALESCE(EXCLUDED.address, pharmacies.address),
            location  = EXCLUDED.location,
            is_active = EXCLUDED.is_active
    RETURNING * INTO v_row;

    RETURN jsonb_build_object(
        'id',           v_row.id,
        'name',         v_row.name,
        'phone_number', v_row.phone_number,
        'address',      v_row.address,
        'latitude',     ST_Y(v_row.location::geometry),
        'longitude',    ST_X(v_row.location::geometry),
        'is_active',    v_row.is_active,
        'created_at',   v_row.created_at,
        'updated_at',   v_row.updated_at
    );
END;
$$;


-- 9b. Patch a pharmacy by id ------------------------------------------------
CREATE OR REPLACE FUNCTION update_pharmacy(
    p_id        UUID,
    p_name      TEXT DEFAULT NULL,
    p_address   TEXT DEFAULT NULL,
    p_lat       DOUBLE PRECISION DEFAULT NULL,
    p_lon       DOUBLE PRECISION DEFAULT NULL,
    p_is_active BOOLEAN DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_row pharmacies;
BEGIN
    IF (p_lat IS NULL) <> (p_lon IS NULL) THEN
        RAISE EXCEPTION 'update_pharmacy: latitude and longitude must be supplied together';
    END IF;

    UPDATE pharmacies p
       SET name      = COALESCE(p_name, p.name),
           address   = COALESCE(p_address, p.address),
           is_active = COALESCE(p_is_active, p.is_active),
           location  = CASE
                           WHEN p_lat IS NULL THEN p.location
                           ELSE ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography
                       END
     WHERE p.id = p_id
    RETURNING * INTO v_row;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('found', FALSE);
    END IF;

    RETURN jsonb_build_object(
        'found',        TRUE,
        'id',           v_row.id,
        'name',         v_row.name,
        'phone_number', v_row.phone_number,
        'address',      v_row.address,
        'latitude',     ST_Y(v_row.location::geometry),
        'longitude',    ST_X(v_row.location::geometry),
        'is_active',    v_row.is_active,
        'created_at',   v_row.created_at,
        'updated_at',   v_row.updated_at
    );
END;
$$;


-- 9c. Remember a patient's location pin -------------------------------------
CREATE OR REPLACE FUNCTION upsert_patient_location(
    p_phone_number TEXT,
    p_lat          DOUBLE PRECISION,
    p_lon          DOUBLE PRECISION,
    p_label        TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_row patient_sessions;
BEGIN
    IF p_lat IS NULL OR p_lon IS NULL
       OR p_lat < -90 OR p_lat > 90 OR p_lon < -180 OR p_lon > 180 THEN
        RAISE EXCEPTION 'upsert_patient_location: coordinates out of range (lat=%, lon=%)', p_lat, p_lon;
    END IF;

    INSERT INTO patient_sessions (
        phone_number, location, address_label, last_inbound_at, location_updated_at
    )
    VALUES (
        p_phone_number,
        ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography,
        p_label,
        NOW(),
        NOW()
    )
    ON CONFLICT (phone_number) DO UPDATE
        SET location            = EXCLUDED.location,
            address_label       = COALESCE(EXCLUDED.address_label, patient_sessions.address_label),
            last_inbound_at     = NOW(),
            location_updated_at = NOW()
    RETURNING * INTO v_row;

    RETURN jsonb_build_object(
        'phone_number',               v_row.phone_number,
        'latitude',                   ST_Y(v_row.location::geometry),
        'longitude',                  ST_X(v_row.location::geometry),
        'address_label',              v_row.address_label,
        'pending_media_url',          v_row.pending_media_url,
        'pending_media_content_type', v_row.pending_media_content_type,
        'location_updated_at',        v_row.location_updated_at
    );
END;
$$;


-- 9d. Read a patient session ------------------------------------------------
CREATE OR REPLACE FUNCTION get_patient_session(p_phone_number TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_row patient_sessions;
BEGIN
    SELECT * INTO v_row FROM patient_sessions s WHERE s.phone_number = p_phone_number;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('found', FALSE);
    END IF;

    RETURN jsonb_build_object(
        'found',                      TRUE,
        'phone_number',               v_row.phone_number,
        'latitude',                   ST_Y(v_row.location::geometry),
        'longitude',                  ST_X(v_row.location::geometry),
        'address_label',              v_row.address_label,
        'pending_media_url',          v_row.pending_media_url,
        'pending_media_content_type', v_row.pending_media_content_type,
        'location_updated_at',        v_row.location_updated_at,
        'last_inbound_at',            v_row.last_inbound_at
    );
END;
$$;


-- 9e. Park / clear a photo that arrived before a location pin ----------------
CREATE OR REPLACE FUNCTION set_pending_media(
    p_phone_number TEXT,
    p_media_url    TEXT,
    p_content_type TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO patient_sessions (
        phone_number, pending_media_url, pending_media_content_type, last_inbound_at
    )
    VALUES (p_phone_number, p_media_url, p_content_type, NOW())
    ON CONFLICT (phone_number) DO UPDATE
        SET pending_media_url          = EXCLUDED.pending_media_url,
            pending_media_content_type = EXCLUDED.pending_media_content_type,
            last_inbound_at            = NOW();

    RETURN jsonb_build_object('phone_number', p_phone_number, 'pending_media_url', p_media_url);
END;
$$;


-- 9f. Create a prescription request -----------------------------------------
CREATE OR REPLACE FUNCTION create_prescription_request(
    p_patient_phone  TEXT,
    p_media_url      TEXT,
    p_extracted_drugs JSONB DEFAULT '[]'::jsonb,
    p_lat            DOUBLE PRECISION DEFAULT NULL,
    p_lon            DOUBLE PRECISION DEFAULT NULL,
    p_status         TEXT DEFAULT 'pending',
    p_failure_reason TEXT DEFAULT NULL,
    p_ai_raw         JSONB DEFAULT NULL,
    p_content_type   TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_row prescription_requests;
BEGIN
    INSERT INTO prescription_requests (
        patient_phone, media_url, media_content_type, extracted_drugs,
        ai_raw_response, patient_location, status, failure_reason
    )
    VALUES (
        p_patient_phone,
        p_media_url,
        p_content_type,
        COALESCE(p_extracted_drugs, '[]'::jsonb),
        p_ai_raw,
        CASE
            WHEN p_lat IS NULL OR p_lon IS NULL THEN NULL
            ELSE ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography
        END,
        COALESCE(p_status, 'pending'),
        p_failure_reason
    )
    RETURNING * INTO v_row;

    RETURN jsonb_build_object(
        'id',              v_row.id,
        'short_code',      v_row.short_code,
        'patient_phone',   v_row.patient_phone,
        'media_url',       v_row.media_url,
        'extracted_drugs', v_row.extracted_drugs,
        'status',          v_row.status,
        'failure_reason',  v_row.failure_reason,
        'latitude',        ST_Y(v_row.patient_location::geometry),
        'longitude',       ST_X(v_row.patient_location::geometry),
        'created_at',      v_row.created_at
    );
END;
$$;


-- ============================================================================
-- 10. The claim: first-come, first-served with a real lock
--
-- `SELECT ... FOR UPDATE` serialises concurrent claims on the same request, so
-- two pharmacies replying in the same millisecond cannot both win. The loser's
-- transaction blocks, then re-reads status = 'claimed' and is told who won.
-- ============================================================================
CREATE OR REPLACE FUNCTION claim_prescription_request(
    p_short_code          TEXT,
    p_pharmacy_phone      TEXT,
    p_require_broadcast   BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_pharmacy    pharmacies;
    v_request     prescription_requests;
    v_winner      pharmacies;
    v_code        TEXT := upper(btrim(COALESCE(p_short_code, '')));
    v_distance    DOUBLE PRECISION;
    v_broadcast   BOOLEAN;
BEGIN
    SELECT * INTO v_pharmacy
      FROM pharmacies ph
     WHERE ph.phone_number = p_pharmacy_phone
       AND ph.is_active = TRUE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('result', 'unknown_pharmacy', 'short_code', v_code);
    END IF;

    -- Lock the request row for the duration of this transaction.
    SELECT * INTO v_request
      FROM prescription_requests r
     WHERE r.short_code = v_code
     FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('result', 'not_found', 'short_code', v_code);
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM prescription_broadcasts b
         WHERE b.request_id = v_request.id
           AND b.pharmacy_id = v_pharmacy.id
    ) INTO v_broadcast;

    IF p_require_broadcast AND NOT v_broadcast THEN
        RETURN jsonb_build_object(
            'result',     'not_broadcast',
            'short_code', v_request.short_code,
            'pharmacy',   jsonb_build_object('id', v_pharmacy.id, 'name', v_pharmacy.name)
        );
    END IF;

    IF v_request.status = 'claimed' THEN
        SELECT * INTO v_winner FROM pharmacies ph WHERE ph.id = v_request.claimed_by_pharmacy_id;
        RETURN jsonb_build_object(
            'result',     'already_claimed',
            'short_code', v_request.short_code,
            'pharmacy',   jsonb_build_object('id', v_pharmacy.id, 'name', v_pharmacy.name),
            'winner',     jsonb_build_object(
                               'id',           v_winner.id,
                               'name',         v_winner.name,
                               'phone_number', v_winner.phone_number
                           ),
            'claimed_at', v_request.claimed_at
        );
    END IF;

    IF v_request.status <> 'pending' THEN
        RETURN jsonb_build_object(
            'result',     CASE WHEN v_request.status = 'expired' THEN 'expired' ELSE 'not_claimable' END,
            'short_code', v_request.short_code,
            'status',     v_request.status
        );
    END IF;

    UPDATE prescription_requests r
       SET status                 = 'claimed',
           claimed_by_pharmacy_id = v_pharmacy.id,
           claimed_at             = NOW()
     WHERE r.id = v_request.id
    RETURNING * INTO v_request;

    SELECT b.distance_meters INTO v_distance
      FROM prescription_broadcasts b
     WHERE b.request_id = v_request.id
       AND b.pharmacy_id = v_pharmacy.id;

    RETURN jsonb_build_object(
        'result',   'claimed',
        'request',  jsonb_build_object(
                        'id',              v_request.id,
                        'short_code',      v_request.short_code,
                        'patient_phone',   v_request.patient_phone,
                        'extracted_drugs', v_request.extracted_drugs,
                        'status',          v_request.status,
                        'claimed_at',      v_request.claimed_at,
                        'latitude',        ST_Y(v_request.patient_location::geometry),
                        'longitude',       ST_X(v_request.patient_location::geometry)
                    ),
        'pharmacy', jsonb_build_object(
                        'id',              v_pharmacy.id,
                        'name',            v_pharmacy.name,
                        'phone_number',    v_pharmacy.phone_number,
                        'address',         v_pharmacy.address,
                        'latitude',        ST_Y(v_pharmacy.location::geometry),
                        'longitude',       ST_X(v_pharmacy.location::geometry),
                        'distance_meters', v_distance
                    )
    );
END;
$$;


-- ============================================================================
-- 11. Maintenance + reporting RPCs
-- ============================================================================

-- Age out pending requests nobody claimed.
CREATE OR REPLACE FUNCTION expire_stale_prescription_requests(
    p_older_than_minutes INT DEFAULT 30
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_codes TEXT[];
BEGIN
    WITH expired AS (
        UPDATE prescription_requests r
           SET status         = 'expired',
               failure_reason = COALESCE(r.failure_reason,
                                         'No pharmacy claimed the request in time')
         WHERE r.status = 'pending'
           AND r.created_at < NOW() - make_interval(mins => GREATEST(p_older_than_minutes, 1))
        RETURNING r.short_code
    )
    SELECT array_agg(expired.short_code) INTO v_codes FROM expired;

    RETURN jsonb_build_object(
        'expired_count', COALESCE(array_length(v_codes, 1), 0),
        'short_codes',   COALESCE(to_jsonb(v_codes), '[]'::jsonb)
    );
END;
$$;


-- A single prescription with its patient coordinates, winning pharmacy and
-- full broadcast fan-out. Used by GET /api/prescriptions/:id.
CREATE OR REPLACE FUNCTION get_prescription_detail(p_id_or_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_request prescription_requests;
    v_winner  pharmacies;
BEGIN
    SELECT * INTO v_request
      FROM prescription_requests r
     WHERE r.short_code = upper(btrim(p_id_or_code))
        OR (p_id_or_code ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            AND r.id = p_id_or_code::uuid)
     LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('found', FALSE);
    END IF;

    IF v_request.claimed_by_pharmacy_id IS NOT NULL THEN
        SELECT * INTO v_winner FROM pharmacies ph WHERE ph.id = v_request.claimed_by_pharmacy_id;
    END IF;

    RETURN jsonb_build_object(
        'found',           TRUE,
        'id',              v_request.id,
        'short_code',      v_request.short_code,
        'patient_phone',   v_request.patient_phone,
        'media_url',       v_request.media_url,
        'extracted_drugs', v_request.extracted_drugs,
        'status',          v_request.status,
        'failure_reason',  v_request.failure_reason,
        'latitude',        ST_Y(v_request.patient_location::geometry),
        'longitude',       ST_X(v_request.patient_location::geometry),
        'broadcast_count', v_request.broadcast_count,
        'claimed_at',      v_request.claimed_at,
        'created_at',      v_request.created_at,
        'claimed_by',      CASE
                               WHEN v_winner.id IS NULL THEN NULL
                               ELSE jsonb_build_object(
                                        'id',           v_winner.id,
                                        'name',         v_winner.name,
                                        'phone_number', v_winner.phone_number,
                                        'address',      v_winner.address,
                                        'latitude',     ST_Y(v_winner.location::geometry),
                                        'longitude',    ST_X(v_winner.location::geometry)
                                    )
                           END,
        'broadcasts',      COALESCE((
                               SELECT jsonb_agg(
                                          jsonb_build_object(
                                              'pharmacy_id',        ph.id,
                                              'pharmacy_name',      ph.name,
                                              'phone_number',       ph.phone_number,
                                              'distance_meters',    b.distance_meters,
                                              'twilio_message_sid', b.twilio_message_sid,
                                              'delivery_status',    b.delivery_status,
                                              'error_message',      b.error_message,
                                              'created_at',         b.created_at
                                          ) ORDER BY b.distance_meters ASC
                                      )
                                 FROM prescription_broadcasts b
                                 JOIN pharmacies ph ON ph.id = b.pharmacy_id
                                WHERE b.request_id = v_request.id
                           ), '[]'::jsonb)
    );
END;
$$;


-- Dashboard counters, computed in the database.
CREATE OR REPLACE FUNCTION get_rxroute_stats()
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
    SELECT jsonb_build_object(
        'pharmacies', jsonb_build_object(
            'total',  (SELECT count(*) FROM pharmacies),
            'active', (SELECT count(*) FROM pharmacies WHERE is_active)
        ),
        'requests', jsonb_build_object(
            'total',   (SELECT count(*) FROM prescription_requests),
            'pending', (SELECT count(*) FROM prescription_requests WHERE status = 'pending'),
            'claimed', (SELECT count(*) FROM prescription_requests WHERE status = 'claimed'),
            'expired', (SELECT count(*) FROM prescription_requests WHERE status = 'expired'),
            'failed',  (SELECT count(*) FROM prescription_requests WHERE status = 'failed')
        ),
        'broadcasts', jsonb_build_object(
            'total',            (SELECT count(*) FROM prescription_broadcasts),
            'avg_per_request',  (SELECT COALESCE(round(avg(broadcast_count)::numeric, 2), 0)
                                   FROM prescription_requests WHERE broadcast_count > 0),
            'avg_distance_m',   (SELECT COALESCE(round(avg(distance_meters)::numeric, 1), 0)
                                   FROM prescription_broadcasts)
        ),
        'median_claim_seconds', (
            SELECT COALESCE(round(
                percentile_cont(0.5) WITHIN GROUP (
                    ORDER BY EXTRACT(EPOCH FROM (claimed_at - created_at))
                )::numeric, 1), 0)
              FROM prescription_requests
             WHERE claimed_at IS NOT NULL
        ),
        'generated_at', NOW()
    );
$$;


-- Record an inbound webhook; returns duplicate = true on a Twilio retry.
CREATE OR REPLACE FUNCTION register_inbound_message(
    p_message_sid TEXT,
    p_from        TEXT,
    p_to          TEXT,
    p_body        TEXT,
    p_num_media   INTEGER DEFAULT 0,
    p_raw         JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_id UUID;
BEGIN
    INSERT INTO whatsapp_messages (
        message_sid, direction, from_number, to_number, body, num_media, raw_payload
    )
    VALUES (p_message_sid, 'inbound', p_from, p_to, p_body, COALESCE(p_num_media, 0), p_raw)
    ON CONFLICT (message_sid) DO NOTHING
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
        RETURN jsonb_build_object('duplicate', TRUE, 'message_sid', p_message_sid);
    END IF;

    RETURN jsonb_build_object('duplicate', FALSE, 'id', v_id, 'message_sid', p_message_sid);
END;
$$;


-- ============================================================================
-- 12. Read views
--
-- GEOGRAPHY is not directly consumable over PostgREST, so reads go through
-- views that project latitude/longitude as plain floats. security_invoker
-- keeps RLS evaluated as the *caller*, not the view owner.
-- ============================================================================
DROP VIEW IF EXISTS pharmacies_view;
CREATE VIEW pharmacies_view
WITH (security_invoker = true) AS
SELECT
    p.id,
    p.name,
    p.phone_number,
    p.address,
    ST_Y(p.location::geometry) AS latitude,
    ST_X(p.location::geometry) AS longitude,
    p.is_active,
    p.created_at,
    p.updated_at
FROM pharmacies p;

DROP VIEW IF EXISTS prescription_requests_view;
CREATE VIEW prescription_requests_view
WITH (security_invoker = true) AS
SELECT
    r.id,
    r.short_code,
    r.patient_phone,
    r.media_url,
    r.media_content_type,
    r.extracted_drugs,
    ST_Y(r.patient_location::geometry) AS latitude,
    ST_X(r.patient_location::geometry) AS longitude,
    r.status,
    r.failure_reason,
    r.claimed_by_pharmacy_id,
    ph.name         AS claimed_by_name,
    ph.phone_number AS claimed_by_phone,
    r.claimed_at,
    r.broadcast_count,
    r.created_at,
    r.updated_at
FROM prescription_requests r
LEFT JOIN pharmacies ph ON ph.id = r.claimed_by_pharmacy_id;


-- ============================================================================
-- 13. Row Level Security
--
-- No policies are defined, so anon/authenticated reach nothing. The backend
-- connects with the service role key, which bypasses RLS by design.
-- ============================================================================
ALTER TABLE pharmacies             ENABLE ROW LEVEL SECURITY;
ALTER TABLE prescription_requests  ENABLE ROW LEVEL SECURITY;
ALTER TABLE prescription_broadcasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_sessions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_messages      ENABLE ROW LEVEL SECURITY;


-- ============================================================================
-- 14. Grants
-- ============================================================================
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        EXECUTE 'GRANT USAGE ON SCHEMA public TO service_role';
        EXECUTE 'GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role';
        EXECUTE 'GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role';
        EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role';
    END IF;
END;
$$;


-- ============================================================================
-- 15. Tell PostgREST to pick up the new functions and views
-- ============================================================================
NOTIFY pgrst, 'reload schema';
