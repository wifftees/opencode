import { inArray, sql } from "drizzle-orm";
import { Effect } from "effect";
import type { Session } from "@opencode/schema/session";
import type { Database } from "../database/database.js";
import { fromRow } from "./info.js";
import { SessionTable } from "./sql.js";

type Hit = {
  sessionID: Session.ID;
  matchKind: "title" | "content";
  score: number;
  snippet: string;
  messageID: string | null;
  updated: number;
};

export const searchSessions = Effect.fn("SessionStore.search")(function* (
  db: Database.Interface["db"],
  input: Session.SearchInput,
) {
  if (input.query.length > 4096) return [];
  const words = [
    ...new Set(
      input.query.normalize("NFC").match(/[\p{L}\p{N}\p{M}]+/gu) ?? [],
    ),
  ];

  if (words.length === 0 || words.length > 32) return [];
  const query = words.map((word) => `"${word}"*`).join(" AND ");
  const archived = input.archived ? sql`IS NOT NULL` : sql`IS NULL`;
  const hits = yield* db
    .all<Hit>(
      sql`
    WITH hits AS MATERIALIZED (
      SELECT d.session_id AS sessionID, d.message_id AS messageID, d.kind AS matchKind,
        -bm25(session_search_fts) AS score,
        snippet(session_search_fts, 0, '', '', ' … ', 24) AS snippet,
        s.time_updated AS updated
      FROM session_search_fts
      JOIN session_search_document d ON d.id = session_search_fts.rowid
      JOIN session_v2 s ON s.id = d.session_id
      WHERE session_search_fts MATCH ${query}
        AND s.parent_id IS NULL AND s.time_archived ${archived}
    ), ranked AS (
      SELECT *, row_number() OVER (
        PARTITION BY sessionID
        ORDER BY CASE matchKind WHEN 'title' THEN 0 ELSE 1 END, score DESC, messageID DESC
      ) AS position FROM hits
    )
    SELECT sessionID, messageID, matchKind, score, snippet, updated FROM ranked
    WHERE position = 1
    ORDER BY CASE matchKind WHEN 'title' THEN 0 ELSE 1 END, score DESC, updated DESC, sessionID DESC
    LIMIT ${Math.min(input.limit ?? 50, 100)}
  `,
    )
    .pipe(Effect.orDie);

  const titles = yield* db
    .all<{ sessionID: Session.ID; title: string | null; updated: number }>(sql`
      SELECT id AS sessionID, title, time_updated AS updated FROM session_v2
      WHERE parent_id IS NULL AND time_archived ${archived}
    `)
    .pipe(Effect.orDie);
  const literal = input.query.normalize("NFC").trim().toLowerCase();
  const combined = new Map(
    hits.map((hit) => [
      hit.sessionID,
      {
        ...hit,
        score:
          (hit.matchKind === "title" ? 2 : 0) + hit.score / (1 + hit.score),
      },
    ]),
  );
  for (const row of titles) {
    const title = (row.title ?? "").normalize("NFC").toLowerCase();

    if (!title.includes(literal)) continue;
    const score = title === literal ? 4 : title.startsWith(literal) ? 3 : 1;
    const previous = combined.get(row.sessionID);

    if (previous?.matchKind === "title" && previous.score >= score) continue;
    combined.set(row.sessionID, {
      ...row,
      matchKind: "title",
      score,
      snippet: "",
      messageID: null,
    });
  }
  const ranked = [...combined.values()]
    .sort(
      (a, b) =>
        Number(b.matchKind === "title") - Number(a.matchKind === "title") ||
        b.score - a.score ||
        b.updated - a.updated ||
        b.sessionID.localeCompare(a.sessionID),
    )
    .slice(0, Math.min(input.limit ?? 50, 100));

  if (ranked.length === 0) return [];
  const rows = yield* db
    .select()
    .from(SessionTable)
    .where(
      inArray(
        SessionTable.id,
        ranked.map((hit) => hit.sessionID),
      ),
    )
    .all()
    .pipe(Effect.orDie);
  const sessions = new Map(rows.map((row) => [row.id, fromRow(row)]));

  return ranked.flatMap((hit): Session.SearchResult[] => {
    const session = sessions.get(hit.sessionID);

    if (!session) return [];

    return [
      {
        session,
        matchKind: hit.matchKind,
        score: hit.score,
        ...(hit.matchKind === "content"
          ? {
              snippet:
                hit.snippet.length > 320
                  ? hit.snippet.slice(0, 319) + "…"
                  : hit.snippet,
              ...(hit.messageID ? { messageID: hit.messageID } : {}),
            }
          : {}),
      },
    ];
  });
});
