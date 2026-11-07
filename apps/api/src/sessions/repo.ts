import { randomInt } from "node:crypto";
import { JOIN_CODE_LENGTH, type CreateSessionRequest, type JoinSessionResponse, type Session } from "@ads/contracts";
import type pg from "pg";

// The SQL for sessions and their target languages (ADR-0002; tables in
// migrations/0002_sessions.sql). Every query is scoped to the host, so one host
// never sees or changes another's session: it is simply not found.

type Db = Pick<pg.Pool, "query">;

// Ids are uuids; anything else is not found, without asking Postgres.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// No 0/O or 1/I lookalikes, as in the mock API: codes are read off a screen.
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function newJoinCode(): string {
  return Array.from({ length: JOIN_CODE_LENGTH }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join("");
}

type SessionRow = Omit<Session, "createdAt" | "startedAt" | "endedAt" | "languages"> & {
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  languages: { lang: string; peakListeners: number; trackStatus: string | null }[];
};

// One session with its languages in the host's order, and each language's
// translation track status once the session has started.
const SELECT_SESSION = `
  select s.id, s.join_code as "joinCode", s.title, s.source_lang as "sourceLang", s.provider, s.status,
    s.created_at as "createdAt", s.started_at as "startedAt", s.ended_at as "endedAt",
    coalesce(
      json_agg(json_build_object('lang', l.lang, 'peakListeners', l.peak_listeners, 'trackStatus', t.status)
        order by l.position) filter (where l.lang is not null),
      '[]'
    ) as languages
  from sessions s
  left join session_languages l on l.session_id = s.id
  left join translation_tracks t on t.session_id = l.session_id and t.lang = l.lang
  where s.id = $1 and s.host_id = $2
  group by s.id`;

function toSession(row: SessionRow): Session {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    languages: row.languages.map(({ lang, peakListeners, trackStatus }) => ({
      lang,
      peakListeners,
      ...(trackStatus ? { trackStatus } : {}),
    })),
  } as Session;
}

export async function getSession(db: Db, hostId: string, id: string): Promise<Session | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await db.query<SessionRow>(SELECT_SESSION, [id, hostId]);
  return rows[0] ? toSession(rows[0]) : null;
}

// Creates a draft session with its languages. A join code already used by a
// session that hasn't ended is drawn again.
export async function createSession(pool: pg.Pool, hostId: string, req: CreateSessionRequest): Promise<Session> {
  const client = await pool.connect();
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await client.query("begin");
        const { rows } = await client.query<{ id: string }>(
          `insert into sessions (host_id, join_code, title, source_lang, provider)
           values ($1, $2, $3, $4, $5) returning id`,
          [hostId, newJoinCode(), req.title, req.sourceLang, req.provider],
        );
        const id = rows[0]!.id;
        await client.query(
          `insert into session_languages (session_id, lang, position)
           select $1, lang, position from unnest($2::text[]) with ordinality as t(lang, position)`,
          [id, req.targetLangs],
        );
        await client.query("commit");
        return (await getSession(client, hostId, id))!;
      } catch (err) {
        await client.query("rollback");
        const codeTaken = (err as { constraint?: string }).constraint === "sessions_join_code_open";
        if (!codeTaken || attempt >= 5) throw err;
      }
    }
  } finally {
    client.release();
  }
}

// draft → live. Returns whether this call changed it.
export async function markLive(db: Db, hostId: string, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const { rowCount } = await db.query(
    `update sessions set status = 'live', started_at = now() where id = $1 and host_id = $2 and status = 'draft'`,
    [id, hostId],
  );
  return rowCount === 1;
}

// draft or live → ended. Returns whether this call changed it.
export async function markEnded(db: Db, hostId: string, id: string, reason: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const { rowCount } = await db.query(
    `update sessions set status = 'ended', ended_at = now(), end_reason = $3
     where id = $1 and host_id = $2 and status <> 'ended'`,
    [id, hostId, reason],
  );
  return rowCount === 1;
}

// What a listener sees for a join code: only sessions that haven't ended.
export async function findByJoinCode(db: Db, code: string): Promise<JoinSessionResponse | null> {
  const { rows } = await db.query<JoinSessionResponse>(
    `select s.title, u.name as "hostName", s.source_lang as "sourceLang", s.status,
       array_agg(l.lang order by l.position) as languages
     from sessions s
     join "user" u on u.id = s.host_id
     join session_languages l on l.session_id = s.id
     where s.join_code = $1 and s.status <> 'ended'
     group by s.id, u.name`,
    [code],
  );
  return rows[0] ?? null;
}
