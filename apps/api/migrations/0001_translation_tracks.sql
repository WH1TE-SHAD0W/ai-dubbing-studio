-- Translation tracks (ADR-0018, ADR-0020): one per session and target language.
-- The API decides who translates a track: a worker claims it and holds a lease
-- that its heartbeats renew. The Redis Stream only delivers the job, so this
-- table is the only place that knows the owner.
--
-- session_id has no foreign key yet, because sessions aren't stored so far.
-- The sessions migration adds it:
--   alter table translation_tracks add foreign key (session_id)
--     references sessions (id) on delete cascade;
create table translation_tracks (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  lang text not null check (lang ~ '^[a-z]{2}$'),
  -- pending | claimed | live | ended | failed (trackStatusSchema in packages/contracts)
  status text not null default 'pending'
    check (status in ('pending', 'claimed', 'live', 'ended', 'failed')),
  -- The owner. Kept after `ended` and `failed`, so a retried final report
  -- from the same worker still gets 200.
  worker_id text,
  lease_until timestamptz,
  -- Why the track last changed hands or stopped (sigterm, lease_expired,
  -- session_ended, max_duration, the worker's failure message).
  reason text,
  -- Failed or lost workers so far; at TRACK_MAX_ATTEMPTS the track is failed.
  attempts integer not null default 0,
  -- When the last job for it was put on the stream. Null while one still has
  -- to be sent; the sweeper sends it.
  enqueued_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, lang),
  constraint translation_tracks_owned_has_lease
    check (status not in ('claimed', 'live') or (worker_id is not null and lease_until is not null))
);

-- The sweeper's two scans: expired leases, and pending tracks to (re)send.
create index translation_tracks_lease on translation_tracks (lease_until)
  where status in ('claimed', 'live');
create index translation_tracks_pending on translation_tracks (enqueued_at)
  where status = 'pending';
