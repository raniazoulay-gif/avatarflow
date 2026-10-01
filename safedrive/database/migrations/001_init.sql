-- SafeDrive initial schema (PostgreSQL 14+). UUID keys, audit timestamps, soft delete
-- where data must stay attributable, FK constraints and indexes for every access path.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL,
  password_hash   text NOT NULL,
  display_name    text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  locale          text NOT NULL DEFAULT 'he',
  is_system_admin boolean NOT NULL DEFAULT false,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  failed_logins   integer NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  last_login_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email)) WHERE deleted_at IS NULL;

CREATE TABLE families (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  country_code text NOT NULL DEFAULT 'IL',
  timezone     text NOT NULL DEFAULT 'Asia/Jerusalem',
  is_demo      boolean NOT NULL DEFAULT false,
  created_by   uuid NOT NULL REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);

CREATE TABLE family_members (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id    uuid NOT NULL REFERENCES families (id),
  user_id      uuid NOT NULL REFERENCES users (id),
  role         text NOT NULL CHECK (role IN ('PARENT', 'DRIVER')),
  display_name text NOT NULL,
  joined_at    timestamptz NOT NULL DEFAULT now(),
  removed_at   timestamptz
);
CREATE UNIQUE INDEX family_members_active_uq ON family_members (family_id, user_id) WHERE removed_at IS NULL;
CREATE INDEX family_members_user_idx ON family_members (user_id) WHERE removed_at IS NULL;

CREATE TABLE drivers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id          uuid NOT NULL REFERENCES families (id),
  member_id          uuid NOT NULL UNIQUE REFERENCES family_members (id),
  user_id            uuid NOT NULL REFERENCES users (id),
  display_name       text NOT NULL,
  consent_at         timestamptz NOT NULL,
  consent_version    text NOT NULL,
  safety_score       integer,
  score_updated_at   timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);
CREATE INDEX drivers_family_idx ON drivers (family_id) WHERE deleted_at IS NULL;
CREATE INDEX drivers_user_idx ON drivers (user_id) WHERE deleted_at IS NULL;

CREATE TABLE family_invites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id    uuid NOT NULL REFERENCES families (id),
  code_hash    text NOT NULL UNIQUE,
  role         text NOT NULL CHECK (role IN ('PARENT', 'DRIVER')),
  display_name text NOT NULL,
  created_by   uuid NOT NULL REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  used_by      uuid REFERENCES users (id),
  revoked_at   timestamptz
);

CREATE TABLE devices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users (id),
  platform      text NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  model         text,
  app_version   text,
  push_token    text,
  push_provider text,
  capabilities  jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz
);
CREATE INDEX devices_user_idx ON devices (user_id) WHERE revoked_at IS NULL;

-- OS permission state reported by a device (location always/when-in-use, notifications, motion...)
CREATE TABLE permissions (
  device_id  uuid NOT NULL REFERENCES devices (id),
  name       text NOT NULL,
  status     text NOT NULL CHECK (status IN ('granted', 'denied', 'limited', 'undetermined', 'unavailable')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, name)
);

-- Refresh-token sessions. Rotation: each refresh replaces the row; reuse of a rotated
-- token revokes the whole chain (stolen-token detection).
CREATE TABLE device_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id),
  device_id    uuid REFERENCES devices (id),
  chain_id     uuid NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  rotated_at   timestamptz,
  revoked_at   timestamptz,
  ip           text,
  user_agent   text
);
CREATE INDEX device_sessions_user_idx ON device_sessions (user_id);
CREATE INDEX device_sessions_chain_idx ON device_sessions (chain_id);

CREATE TABLE monitoring_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id    uuid NOT NULL REFERENCES families (id),
  driver_id    uuid NOT NULL REFERENCES drivers (id),
  requested_by uuid NOT NULL REFERENCES users (id),
  status       text NOT NULL CHECK (status IN ('REQUESTED', 'PENDING', 'ACTIVE', 'DECLINED', 'UNAVAILABLE',
                                               'PERMISSION_REQUIRED', 'EXPIRED', 'CANCELLED', 'COMPLETED')),
  reason       text,
  trip_id      uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
CREATE INDEX monitoring_requests_driver_idx ON monitoring_requests (driver_id, created_at DESC);

CREATE TABLE trips (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id             uuid NOT NULL REFERENCES families (id),
  driver_id             uuid NOT NULL REFERENCES drivers (id),
  device_id             uuid REFERENCES devices (id),
  state                 text NOT NULL,
  is_demo               boolean NOT NULL DEFAULT false,
  demo_scenario         text,
  started_by            text NOT NULL DEFAULT 'driver' CHECK (started_by IN ('driver', 'remote_request', 'demo')),
  monitoring_request_id uuid REFERENCES monitoring_requests (id),
  started_at            timestamptz NOT NULL DEFAULT now(),
  ended_at              timestamptz,
  start_lat double precision, start_lon double precision,
  end_lat   double precision, end_lon   double precision,
  distance_m            double precision NOT NULL DEFAULT 0,
  moving_seconds        integer NOT NULL DEFAULT 0,
  max_speed_kmh         double precision NOT NULL DEFAULT 0,
  speeding_count        integer NOT NULL DEFAULT 0,
  critical_count        integer NOT NULL DEFAULT 0,
  hard_braking_count    integer NOT NULL DEFAULT 0,
  hard_acceleration_count integer NOT NULL DEFAULT 0,
  phone_usage_count     integer NOT NULL DEFAULT 0,
  score                 integer NOT NULL DEFAULT 100,
  score_breakdown       jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- serialised engine state (speeding tracker, motion detector, last fix): lets any
  -- API instance continue processing the trip after a restart
  engine_state          jsonb NOT NULL DEFAULT '{}'::jsonb,
  live                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seq              integer NOT NULL DEFAULT 0,
  last_point_at         timestamptz,
  offline_notified_at   timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trips_driver_idx ON trips (driver_id, started_at DESC);
CREATE INDEX trips_family_idx ON trips (family_id, started_at DESC);
CREATE INDEX trips_live_idx ON trips (state) WHERE ended_at IS NULL;
-- At most one live trip per driver
CREATE UNIQUE INDEX trips_one_live_per_driver ON trips (driver_id) WHERE ended_at IS NULL;

ALTER TABLE monitoring_requests ADD CONSTRAINT monitoring_requests_trip_fk FOREIGN KEY (trip_id) REFERENCES trips (id);

-- High-volume raw telemetry, range-partitioned by month (see maintenance job).
-- Idempotency: (trip_id, seq, recorded_at) - a retried upload of the same point is a no-op.
CREATE TABLE telemetry_points (
  trip_id          uuid NOT NULL,
  seq              integer NOT NULL,
  recorded_at      timestamptz NOT NULL,
  client_id        uuid NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now(),
  lat              double precision NOT NULL,
  lon              double precision NOT NULL,
  altitude_m       double precision,
  speed_kmh        double precision,
  heading_deg      double precision,
  accuracy_m       double precision,
  source           text NOT NULL DEFAULT 'gps' CHECK (source IN ('gps', 'simulated')),
  limit_kmh        double precision,
  limit_source     text,
  limit_confidence double precision,
  PRIMARY KEY (trip_id, seq, recorded_at)
) PARTITION BY RANGE (recorded_at);
CREATE TABLE telemetry_points_default PARTITION OF telemetry_points DEFAULT;
CREATE INDEX telemetry_points_trip_time_idx ON telemetry_points (trip_id, recorded_at);

CREATE TABLE road_segments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider     text NOT NULL,
  external_id  text NOT NULL,
  name         text,
  ref          text,
  country      text,
  region       text,
  highway      text,
  maxspeed_kmh double precision,
  center_lat   double precision,
  center_lon   double precision,
  tags         jsonb NOT NULL DEFAULT '{}'::jsonb,
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_id)
);

-- Speed-limit cache per ~30 m grid cell and heading bucket. Negative answers are cached too
-- (limit_kmh NULL) with a shorter TTL, so a road without data is not re-queried each second.
CREATE TABLE speed_limits (
  cell_key        text PRIMARY KEY,
  provider        text NOT NULL,
  limit_kmh       double precision,
  confidence      double precision NOT NULL DEFAULT 0,
  road_segment_id uuid REFERENCES road_segments (id),
  road_name       text,
  country         text,
  region          text,
  fetched_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL
);
CREATE INDEX speed_limits_expiry_idx ON speed_limits (expires_at);

CREATE TABLE provider_cache (
  provider   text NOT NULL,
  cache_key  text NOT NULL,
  value      jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (provider, cache_key)
);

CREATE TABLE safety_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES families (id),
  driver_id   uuid NOT NULL REFERENCES drivers (id),
  trip_id     uuid REFERENCES trips (id),
  type        text NOT NULL CHECK (type IN ('SPEEDING', 'HARD_BRAKING', 'HARD_ACCELERATION', 'GPS_UNAVAILABLE',
                                            'SPEED_LIMIT_UNAVAILABLE', 'PHONE_USAGE', 'SOS', 'TRIP_STARTED',
                                            'TRIP_ENDED', 'CONNECTIVITY_LOSS', 'PERMISSION_PROBLEM')),
  severity    text NOT NULL DEFAULT 'SAFE' CHECK (severity IN ('SAFE', 'ATTENTION', 'WARNING', 'CRITICAL')),
  occurred_at timestamptz NOT NULL,
  ended_at    timestamptz,
  lat double precision, lon double precision,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_demo     boolean NOT NULL DEFAULT false,
  dedupe_key  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX safety_events_trip_idx ON safety_events (trip_id, occurred_at);
CREATE INDEX safety_events_driver_idx ON safety_events (driver_id, occurred_at DESC);
CREATE UNIQUE INDEX safety_events_dedupe_uq ON safety_events (trip_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE speeding_events (
  id              uuid PRIMARY KEY REFERENCES safety_events (id),
  trip_id         uuid NOT NULL REFERENCES trips (id),
  status          text NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
  start_time      timestamptz NOT NULL,
  end_time        timestamptz,
  duration_s      integer NOT NULL DEFAULT 0,
  start_speed_kmh double precision NOT NULL,
  max_speed_kmh   double precision NOT NULL,
  speed_limit_kmh double precision NOT NULL,
  max_excess_kmh  double precision NOT NULL,
  max_excess_pct  double precision NOT NULL,
  severity        text NOT NULL,
  start_lat double precision, start_lon double precision,
  max_lat   double precision, max_lon   double precision,
  road            text,
  limit_source    text,
  end_reason      text
);
CREATE INDEX speeding_events_trip_idx ON speeding_events (trip_id, start_time);
CREATE UNIQUE INDEX speeding_events_one_open ON speeding_events (trip_id) WHERE status = 'OPEN';

CREATE TABLE safety_scores (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id   uuid NOT NULL REFERENCES drivers (id),
  trip_id     uuid REFERENCES trips (id),
  scope       text NOT NULL CHECK (scope IN ('trip', 'driver_rolling')),
  score       integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  breakdown   jsonb NOT NULL DEFAULT '{}'::jsonb,
  computed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX safety_scores_driver_idx ON safety_scores (driver_id, computed_at DESC);

CREATE TABLE notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES families (id),
  recipient_id    uuid NOT NULL REFERENCES users (id),
  driver_id       uuid REFERENCES drivers (id),
  trip_id         uuid REFERENCES trips (id),
  type            text NOT NULL,
  priority        text NOT NULL,
  title           text NOT NULL,
  body            text NOT NULL,
  data            jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key      text NOT NULL,
  sound           boolean NOT NULL DEFAULT false,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  read_at         timestamptz,
  push_status     text NOT NULL DEFAULT 'pending' CHECK (push_status IN ('pending', 'sent', 'failed', 'skipped')),
  push_attempts   integer NOT NULL DEFAULT 0,
  push_error      text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recipient_id, dedupe_key)
);
CREATE INDEX notifications_recipient_idx ON notifications (recipient_id, created_at DESC);
CREATE INDEX notifications_push_queue_idx ON notifications (next_attempt_at) WHERE push_status = 'pending';

CREATE TABLE notification_preferences (
  user_id    uuid NOT NULL REFERENCES users (id),
  family_id  uuid NOT NULL REFERENCES families (id),
  prefs      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, family_id)
);

CREATE TABLE emergency_contacts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id  uuid NOT NULL REFERENCES families (id),
  name       text NOT NULL,
  phone      text NOT NULL,
  relation   text,
  created_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX emergency_contacts_family_idx ON emergency_contacts (family_id) WHERE deleted_at IS NULL;

CREATE TABLE sos_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES families (id),
  driver_id       uuid NOT NULL REFERENCES drivers (id),
  trip_id         uuid REFERENCES trips (id),
  client_id       uuid NOT NULL UNIQUE,
  lat double precision, lon double precision,
  accuracy_m      double precision,
  speed_kmh       double precision,
  triggered_at    timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')),
  acknowledged_by uuid REFERENCES users (id),
  acknowledged_at timestamptz,
  resolved_at     timestamptz,
  is_demo         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sos_events_family_idx ON sos_events (family_id, triggered_at DESC);

CREATE TABLE audit_logs (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  actor_id    uuid,
  family_id   uuid,
  action      text NOT NULL,
  target_type text,
  target_id   text,
  ip          text,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_logs_at_idx ON audit_logs (at DESC);
CREATE INDEX audit_logs_family_idx ON audit_logs (family_id, at DESC);
CREATE INDEX audit_logs_action_idx ON audit_logs (action, at DESC);

-- Layered configuration: scope 'global', 'country:IL' or 'family:<uuid>'.
CREATE TABLE app_config (
  scope      text NOT NULL,
  key        text NOT NULL,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  PRIMARY KEY (scope, key)
);

-- External API usage accounting (cost monitoring)
CREATE TABLE provider_usage (
  provider   text NOT NULL,
  day        date NOT NULL,
  calls      integer NOT NULL DEFAULT 0,
  errors     integer NOT NULL DEFAULT 0,
  cache_hits integer NOT NULL DEFAULT 0,
  total_ms   bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, day)
);
