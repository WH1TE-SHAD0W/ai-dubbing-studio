import type { ClaimConflictReason, OwnerConflictReason, TrackStatus } from "@ads/contracts";
import type pg from "pg";

// The SQL for translation tracks (ADR-0018, ADR-0020; table in
// migrations/0001_translation_tracks.sql). Postgres is the one place that
// knows who owns a track. Each change is a single UPDATE … WHERE … RETURNING,
// so two workers claiming the same track at once get exactly one row between
// them, under the default READ COMMITTED isolation and with several API
// instances too.

type Db = Pick<pg.Pool, "query">;

export type Track = {
  id: string;
  sessionId: string;
  lang: string;
  status: TrackStatus;
  workerId: string | null;
  leaseUntil: Date | null;
  reason: string | null;
  attempts: number;
  enqueuedAt: Date | null;
};

// A track whose job has to go on the stream.
export type TrackToSend = Pick<Track, "id" | "sessionId" | "lang">;

const COLUMNS = `id, session_id as "sessionId", lang, status, worker_id as "workerId",
  lease_until as "leaseUntil", reason, attempts, enqueued_at as "enqueuedAt"`;

// Track ids are uuids; anything else is an unknown track, without asking Postgres
// (which would answer "invalid input syntax" with a 500).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isTrackId = (id: string) => UUID.test(id);

// The statuses in which a worker owns the track and holds a lease.
const OWNED = `status in ('claimed', 'live')`;

// Creates the pending tracks of a session, one per target language. Tracks that
// exist already are kept as they are. Returns all of them.
export async function openTracks(db: Db, sessionId: string, langs: string[]): Promise<Track[]> {
  await db.query(
    `insert into translation_tracks (session_id, lang)
     select $1, lang from unnest($2::text[]) as lang
     on conflict (session_id, lang) do nothing`,
    [sessionId, langs],
  );
  const { rows } = await db.query<Track>(
    `select ${COLUMNS} from translation_tracks where session_id = $1 and lang = any($2::text[]) order by lang`,
    [sessionId, langs],
  );
  return rows;
}

// Ends every track of a session (the host ended it). The owner is kept, so its
// next heartbeat gets 409 ended and the worker stops. Returns the ended ids.
export async function endTracks(db: Db, sessionId: string, reason: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `update translation_tracks set status = 'ended', lease_until = null, reason = $2, updated_at = now()
     where session_id = $1 and status not in ('ended', 'failed')
     returning id`,
    [sessionId, reason],
  );
  return rows.map((r) => r.id);
}

export async function getTracks(db: Db, sessionId?: string): Promise<Track[]> {
  const { rows } = sessionId
    ? await db.query<Track>(`select ${COLUMNS} from translation_tracks where session_id = $1 order by lang`, [sessionId])
    : await db.query<Track>(`select ${COLUMNS} from translation_tracks order by created_at desc, lang limit 100`);
  return rows;
}

export type ClaimResult = { ok: true; track: Track } | { ok: false; reason: ClaimConflictReason };

// A worker takes the track. It succeeds when the track is pending, when its
// lease ran out (the old worker is gone; that counts as an attempt), or when
// this worker owns it already (a retried claim).
export async function claimTrack(db: Db, trackId: string, workerId: string, leaseTtlSec: number): Promise<ClaimResult> {
  if (!isTrackId(trackId)) return { ok: false, reason: "unknown_track" };
  const { rows } = await db.query<Track>(
    `update translation_tracks set
       status = case when status = 'live' and worker_id = $2 then 'live' else 'claimed' end,
       attempts = attempts + case when ${OWNED} and worker_id <> $2 then 1 else 0 end,
       worker_id = $2,
       lease_until = now() + make_interval(secs => $3),
       updated_at = now()
     where id = $1
       and (status = 'pending' or (${OWNED} and (worker_id = $2 or lease_until < now())))
     returning ${COLUMNS}`,
    [trackId, workerId, leaseTtlSec],
  );
  if (rows[0]) return { ok: true, track: rows[0] };

  const current = await findOwner(db, trackId);
  if (!current) return { ok: false, reason: "unknown_track" };
  if (current.status === "ended" || current.status === "failed") return { ok: false, reason: "ended" };
  return { ok: false, reason: "owned" };
}

export type OwnerResult = { ok: true } | { ok: false; reason: OwnerConflictReason };

// Renews the lease; `live` also marks the track live.
export async function renewLease(
  db: Db,
  trackId: string,
  workerId: string,
  leaseTtlSec: number,
  live = false,
): Promise<OwnerResult> {
  if (!isTrackId(trackId)) return { ok: false, reason: "not_owner" };
  const { rowCount } = await db.query(
    `update translation_tracks set
       status = case when $4 then 'live' else status end,
       lease_until = now() + make_interval(secs => $3),
       updated_at = now()
     where id = $1 and worker_id = $2 and ${OWNED}`,
    [trackId, workerId, leaseTtlSec, live],
  );
  return rowCount ? { ok: true } : ownerConflict(db, trackId);
}

// The worker stopped on its own (for example the maximum job length).
export async function endTrack(db: Db, trackId: string, workerId: string, reason: string): Promise<OwnerResult> {
  if (!isTrackId(trackId)) return { ok: false, reason: "not_owner" };
  const { rowCount } = await db.query(
    `update translation_tracks set status = 'ended', lease_until = null, reason = $3, updated_at = now()
     where id = $1 and worker_id = $2 and ${OWNED}`,
    [trackId, workerId, reason],
  );
  return rowCount ? { ok: true } : finalReportConflict(db, trackId, workerId);
}

// requeue: the track is pending again and its job must be sent.
export type FailResult = { ok: true; requeue: boolean } | { ok: false; reason: OwnerConflictReason };

// The worker gave up. The track goes back to pending for another worker, or
// is failed once maxAttempts workers have given up or vanished.
export async function failTrack(
  db: Db,
  trackId: string,
  workerId: string,
  reason: string,
  maxAttempts: number,
): Promise<FailResult> {
  if (!isTrackId(trackId)) return { ok: false, reason: "not_owner" };
  const { rows } = await db.query<{ status: "pending" | "failed" }>(
    `update translation_tracks set
       attempts = attempts + 1,
       status = case when attempts + 1 >= $4 then 'failed' else 'pending' end,
       worker_id = case when attempts + 1 >= $4 then worker_id else null end,
       lease_until = null, reason = $3, enqueued_at = null, updated_at = now()
     where id = $1 and worker_id = $2 and ${OWNED}
     returning status`,
    [trackId, workerId, reason, maxAttempts],
  );
  if (rows[0]) return { ok: true, requeue: rows[0].status === "pending" };
  const conflict = await finalReportConflict(db, trackId, workerId);
  // A retried report, or the session ended meanwhile: nothing more to do.
  return conflict.ok ? { ok: true, requeue: false } : conflict;
}

// The worker is shutting down (SIGTERM) and gives the track back. Not counted
// as an attempt: the worker did nothing wrong.
export async function releaseTrack(db: Db, trackId: string, workerId: string, reason: string): Promise<OwnerResult> {
  if (!isTrackId(trackId)) return { ok: false, reason: "not_owner" };
  const { rowCount } = await db.query(
    `update translation_tracks set
       status = 'pending', worker_id = null, lease_until = null, reason = $3, enqueued_at = null, updated_at = now()
     where id = $1 and worker_id = $2 and ${OWNED}`,
    [trackId, workerId, reason],
  );
  return rowCount ? { ok: true } : ownerConflict(db, trackId);
}

// Owned tracks whose lease ran out: the worker crashed or lost its network.
// Each goes back to pending (or failed after maxAttempts). Returns the ones
// that are pending again, to send their jobs.
export async function expireLeases(db: Db, maxAttempts: number): Promise<TrackToSend[]> {
  const { rows } = await db.query<TrackToSend & { status: TrackStatus }>(
    `update translation_tracks set
       attempts = attempts + 1,
       status = case when attempts + 1 >= $1 then 'failed' else 'pending' end,
       worker_id = case when attempts + 1 >= $1 then worker_id else null end,
       lease_until = null, reason = 'lease_expired', enqueued_at = null, updated_at = now()
     where ${OWNED} and lease_until < now()
     returning id, session_id as "sessionId", lang, status`,
    [maxAttempts],
  );
  return rows.filter((r) => r.status === "pending").map(({ id, sessionId, lang }) => ({ id, sessionId, lang }));
}

// Pending tracks whose job still has to go on the stream, and, with
// staleAfterSec, those sent that long ago without a worker claiming them
// (the message was lost).
export async function tracksToSend(db: Db, staleAfterSec: number | null, limit = 100): Promise<TrackToSend[]> {
  const { rows } = await db.query<TrackToSend>(
    `select id, session_id as "sessionId", lang from translation_tracks
     where status = 'pending'
       and (enqueued_at is null or ($1::int is not null and enqueued_at < now() - make_interval(secs => $1::int)))
     order by created_at
     limit $2`,
    [staleAfterSec, limit],
  );
  return rows;
}

export async function markSent(db: Db, trackIds: string[]): Promise<void> {
  if (trackIds.length === 0) return;
  await db.query(
    `update translation_tracks set enqueued_at = now(), updated_at = now()
     where id = any($1::uuid[]) and status = 'pending'`,
    [trackIds],
  );
}

async function findOwner(db: Db, trackId: string) {
  const { rows } = await db.query<{ status: TrackStatus; workerId: string | null }>(
    `select status, worker_id as "workerId" from translation_tracks where id = $1`,
    [trackId],
  );
  return rows[0];
}

// Why a worker's call didn't match: the track is over, or it isn't theirs.
async function ownerConflict(db: Db, trackId: string): Promise<OwnerResult> {
  const current = await findOwner(db, trackId);
  if (current && (current.status === "ended" || current.status === "failed")) return { ok: false, reason: "ended" };
  return { ok: false, reason: "not_owner" };
}

// A final report (ended or failed) that is retried, or comes after the session
// ended under the worker, is fine: the track is already over and was theirs.
async function finalReportConflict(db: Db, trackId: string, workerId: string): Promise<OwnerResult> {
  const current = await findOwner(db, trackId);
  if (current && (current.status === "ended" || current.status === "failed")) {
    return current.workerId === workerId ? { ok: true } : { ok: false, reason: "ended" };
  }
  return { ok: false, reason: "not_owner" };
}
