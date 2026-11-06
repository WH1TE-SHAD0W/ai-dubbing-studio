-- Sessions and their target languages (ADR-0002). A session belongs to one
-- host (Better Auth's "user" table) and goes draft → live → ended. Audio,
-- transcripts and listener identities are never stored.
create table sessions (
  id uuid primary key default gen_random_uuid(),
  host_id text not null references "user" (id) on delete cascade,
  -- Typed by listeners or read from a QR code (ADR-0014).
  join_code text not null check (join_code ~ '^[A-Z0-9]{6}$'),
  title text not null check (length(title) between 1 and 120),
  source_lang text not null check (source_lang ~ '^[a-z]{2}$'),
  provider text not null default 'gemini',
  status text not null default 'draft' check (status in ('draft', 'live', 'ended')),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  ended_at timestamptz,
  -- Why it ended: host_ended so far.
  end_reason text,
  -- A draft can be ended without ever going live, so only live needs a start.
  constraint sessions_live_has_start check (status <> 'live' or started_at is not null),
  constraint sessions_ended_has_end check (status <> 'ended' or ended_at is not null)
);

-- Join codes are short, so they are reused: unique only among sessions that
-- haven't ended (ADR-0002).
create unique index sessions_join_code_open on sessions (join_code) where status <> 'ended';
create index sessions_host on sessions (host_id, created_at desc);

create table session_languages (
  session_id uuid not null references sessions (id) on delete cascade,
  lang text not null check (lang ~ '^[a-z]{2}$'),
  -- The order the host picked them in.
  position integer not null,
  -- Usage: the most listeners this language had at once (ADR-0002).
  peak_listeners integer not null default 0 check (peak_listeners >= 0),
  primary key (session_id, lang)
);

-- Each translation track is one target language of a session, and goes with
-- it. Tracks opened by the development `tracks open` command (before sessions
-- were stored) belong to no session, so they are removed first.
delete from translation_tracks t
where not exists (select 1 from session_languages l where l.session_id = t.session_id and l.lang = t.lang);
alter table translation_tracks
  add constraint translation_tracks_language_fk foreign key (session_id, lang)
  references session_languages (session_id, lang) on delete cascade;
