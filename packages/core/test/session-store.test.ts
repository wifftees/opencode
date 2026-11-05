import { describe, expect } from "bun:test";
import { asc, eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import { Bus } from "@opencode/core/bus";
import searchMigration from "../src/database/migration/20261105130000_session_search";
import { Database } from "@opencode/core/database/database";
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder";
import { ProjectTable } from "@opencode/core/project/sql";
import { SessionHistory } from "@opencode/core/session/history";
import { SessionProjector } from "@opencode/core/session/projector";
import {
  SessionMessageTable,
  SessionPartTable,
} from "@opencode/core/session/sql";
import { SessionStore } from "@opencode/core/session/store";
import { Agent } from "@opencode/schema/agent";
import { Event } from "@opencode/schema/event";
import { Model } from "@opencode/schema/model";
import { Project } from "@opencode/schema/project";
import { Provider } from "@opencode/schema/provider";
import { AbsolutePath } from "@opencode/schema/schema";
import { Session } from "@opencode/schema/session";
import { SessionEvent } from "@opencode/schema/session-event";
import { SessionMessage } from "@opencode/schema/session-message";
import { LayerNode } from "@opencode/util/effect/layer-node";
import { testEffect } from "./lib/effect";

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
    ]),
    [Bus.node.replace(Bus.configured({ persist: true }))],
  ),
);

const seedSessions = (rows: { id: string; updated: number }[]) =>
  Effect.gen(function* () {
    const database = yield* Database.Service;
    const bus = yield* Bus.Service;
    const directory = AbsolutePath.make("/project");
    yield* database.db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
      .run();
    yield* Effect.forEach(rows, (row) =>
      Effect.gen(function* () {
        const sessionID = Session.ID.make(row.id);
        yield* bus.publish(SessionEvent.Created, {
          sessionID,
          projectID: Project.ID.global,
          location: { directory },
          slug: "store-test",
          version: "test",
        });
        yield* bus.replay({
          id: Event.ID.create(),
          created: row.updated,
          aggregateID: sessionID,
          seq: 1,
          type: Bus.versionedType(SessionEvent.Renamed.type, 1),
          data: { sessionID, title: row.id },
        });
      }),
    );
    return bus;
  });

describe("SessionStore", () => {
  it.effect(
    "lists by updated time and ID with exclusive two-item pages in either direction",
    () =>
      Effect.gen(function* () {
        yield* seedSessions([
          { id: "ses_d", updated: 20 },
          { id: "ses_z", updated: 10 },
          { id: "ses_a", updated: 30 },
          { id: "ses_c", updated: 20 },
          { id: "ses_y", updated: 10 },
          { id: "ses_e", updated: 30 },
          { id: "ses_b", updated: 20 },
        ]);
        const store = yield* SessionStore.Service;
        expect(
          (yield* store.list()).map((session) => String(session.id)),
        ).toEqual([
          "ses_e",
          "ses_a",
          "ses_d",
          "ses_c",
          "ses_b",
          "ses_z",
          "ses_y",
        ]);
        expect(
          (yield* store.list({ order: "asc" })).map((session) =>
            String(session.id),
          ),
        ).toEqual([
          "ses_y",
          "ses_z",
          "ses_b",
          "ses_c",
          "ses_d",
          "ses_a",
          "ses_e",
        ]);
        const pages: {
          order: "asc" | "desc";
          direction: "next" | "previous";
          ids: string[];
        }[] = [
          { order: "asc", direction: "next", ids: ["ses_d", "ses_a"] },
          { order: "asc", direction: "previous", ids: ["ses_z", "ses_b"] },
          { order: "desc", direction: "next", ids: ["ses_b", "ses_z"] },
          { order: "desc", direction: "previous", ids: ["ses_a", "ses_d"] },
        ];
        yield* Effect.forEach(pages, (page) =>
          Effect.gen(function* () {
            const sessions = yield* store.list({
              order: page.order,
              limit: 2,
              anchor: {
                id: Session.ID.make("ses_c"),
                time: 20,
                direction: page.direction,
              },
            });
            expect(sessions.map((session) => String(session.id))).toEqual(
              page.ids,
            );
          }),
        );
      }),
  );

  it.effect(
    "pages messages by durable sequence, not timestamp or ID, and scopes cursor lookup",
    () =>
      Effect.gen(function* () {
        const sessionID = Session.ID.make("ses_messages");
        const foreignID = Session.ID.make("ses_foreign");
        const bus = yield* seedSessions([
          { id: sessionID, updated: 0 },
          { id: foreignID, updated: 0 },
        ]);
        const store = yield* SessionStore.Service;
        yield* Effect.forEach(
          [
            { id: "evt_z", created: 300 },
            { id: "evt_b", created: 700 },
            { id: "evt_x", created: 100 },
            { id: "evt_c", created: 400 },
            { id: "evt_w", created: 200 },
            { id: "evt_a", created: 600 },
            { id: "evt_y", created: 500 },
          ],
          (event, index) =>
            bus.replay({
              id: Event.ID.make(event.id),
              created: event.created,
              aggregateID: sessionID,
              seq: index + 2,
              type: Bus.versionedType(SessionEvent.Synthetic.type, 1),
              data: { sessionID, text: event.id },
            }),
        );
        yield* bus.publish(
          SessionEvent.Synthetic,
          { sessionID: foreignID, text: "foreign" },
          {
            id: Event.ID.make("evt_foreign"),
          },
        );
        expect(
          (yield* store.messages({ sessionID })).map((message) =>
            String(message.id),
          ),
        ).toEqual([
          "msg_y",
          "msg_a",
          "msg_w",
          "msg_c",
          "msg_x",
          "msg_b",
          "msg_z",
        ]);
        expect(
          (yield* store.messages({ sessionID, order: "asc" })).map((message) =>
            String(message.id),
          ),
        ).toEqual([
          "msg_z",
          "msg_b",
          "msg_x",
          "msg_c",
          "msg_w",
          "msg_a",
          "msg_y",
        ]);
        const pages: {
          order: "asc" | "desc";
          direction: "next" | "previous";
          ids: string[];
        }[] = [
          { order: "asc", direction: "next", ids: ["msg_w", "msg_a"] },
          { order: "asc", direction: "previous", ids: ["msg_b", "msg_x"] },
          { order: "desc", direction: "next", ids: ["msg_x", "msg_b"] },
          { order: "desc", direction: "previous", ids: ["msg_a", "msg_w"] },
        ];
        yield* Effect.forEach(pages, (page) =>
          Effect.gen(function* () {
            const messages = yield* store.messages({
              sessionID,
              order: page.order,
              limit: 2,
              cursor: {
                id: SessionMessage.ID.make("msg_c"),
                direction: page.direction,
              },
            });
            expect(messages.map((message) => String(message.id))).toEqual(
              page.ids,
            );
          }),
        );
        expect(
          yield* store.messages({ sessionID: Session.ID.make("ses_missing") }),
        ).toEqual([]);
        expect(
          yield* store.messages({
            sessionID,
            cursor: {
              id: SessionMessage.ID.make("msg_missing"),
              direction: "next",
            },
          }),
        ).toEqual([]);
        expect(
          yield* store.messages({
            sessionID,
            order: "asc",
            cursor: {
              id: SessionMessage.ID.make("msg_foreign"),
              direction: "next",
            },
          }),
        ).toEqual([]);
      }),
  );

  it.effect(
    "hydrates assistant parts from session_part when present and falls back to inline content",
    () =>
      Effect.gen(function* () {
        const sessionID = Session.ID.make("ses_part_read_fallback");
        yield* seedSessions([{ id: sessionID, updated: 0 }]);
        const database = yield* Database.Service;
        const store = yield* SessionStore.Service;
        const agent = Agent.ID.make("build");
        const model = {
          providerID: Provider.ID.make("anthropic"),
          id: Model.ID.make("claude-sonnet-4-5"),
        };

        const inlineOnlyID = SessionMessage.ID.make("msg_inline_only");
        const splitID = SessionMessage.ID.make("msg_split_parts");

        // 1. Assistant message with inline content only (no session_part rows) -> falls back to inline content
        yield* database.db
          .insert(SessionMessageTable)
          .values({
            id: inlineOnlyID,
            session_id: sessionID,
            seq: 10,
            type: "assistant",
            time_created: 10,
            time_updated: 10,
            data: {
              agent,
              model,
              content: [{ type: "text", text: "inline fallback content" }],
              time: { created: 10, completed: 11 },
            },
          })
          .run();

        // 2. Assistant message with session_part rows -> hydrates parts in ordinal order
        yield* database.db
          .insert(SessionMessageTable)
          .values({
            id: splitID,
            session_id: sessionID,
            seq: 20,
            type: "assistant",
            time_created: 20,
            time_updated: 20,
            data: {
              agent,
              model,
              content: [],
              time: { created: 20, completed: 25 },
            },
          })
          .run();
        yield* database.db
          .insert(SessionPartTable)
          .values([
            {
              message_id: splitID,
              session_id: sessionID,
              ordinal: 0,
              type: "reasoning",
              call_id: null,
              time_created: 20,
              time_updated: 21,
              data: {
                type: "reasoning",
                text: "first reasoning",
                time: { created: 20, completed: 21 },
              },
            },
            {
              message_id: splitID,
              session_id: sessionID,
              ordinal: 1,
              type: "tool",
              call_id: "call_read",
              time_created: 21,
              time_updated: 23,
              data: {
                type: "tool",
                id: "call_read",
                name: "read",
                executed: true,
                state: {
                  status: "completed",
                  input: { path: "src/index.ts" },
                  content: [{ type: "text", text: "export {}" }],
                },
                time: { created: 21, ran: 22, completed: 23 },
              },
            },
            {
              message_id: splitID,
              session_id: sessionID,
              ordinal: 2,
              type: "text",
              call_id: null,
              time_created: 23,
              time_updated: 25,
              data: { type: "text", text: "hydrated from session_part" },
            },
          ])
          .run();

        expect(yield* store.message(inlineOnlyID)).toMatchObject({
          sessionID,
          message: {
            id: inlineOnlyID,
            content: [{ type: "text", text: "inline fallback content" }],
          },
        });
        expect(yield* store.message(splitID)).toMatchObject({
          sessionID,
          message: {
            id: splitID,
            content: [
              { type: "reasoning", text: "first reasoning" },
              { type: "tool", id: "call_read", state: { status: "completed" } },
              { type: "text", text: "hydrated from session_part" },
            ],
          },
        });

        const hydrated = yield* store.messages({ sessionID, order: "asc" });
        expect(hydrated).toMatchObject([
          {
            id: inlineOnlyID,
            content: [{ type: "text", text: "inline fallback content" }],
          },
          {
            id: splitID,
            content: [
              { type: "reasoning", text: "first reasoning" },
              { type: "tool", id: "call_read", state: { status: "completed" } },
              { type: "text", text: "hydrated from session_part" },
            ],
          },
        ]);

        const rows = yield* database.db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, sessionID))
          .orderBy(asc(SessionMessageTable.seq))
          .all();
        expect(
          yield* SessionHistory.decodeMessageRows(database.db, rows),
        ).toEqual(hydrated);
      }),
  );
});

describe("SessionStore text search", () => {
  const message = (
    sessionID: string,
    id: string,
    type: "user" | "assistant",
    data: object,
    seq = 1,
  ) =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service;
      yield* db.run(sql`INSERT INTO session_message(id, session_id, type, seq, time_created, time_updated, data)
        VALUES (${id}, ${sessionID}, ${type}, ${seq}, 1, 1, ${JSON.stringify(data)})`);
    });

  it.effect(
    "ranks titles before message text, matches Unicode word prefixes, excludes archived children and tools",
    () =>
      Effect.gen(function* () {
        yield* seedSessions([
          { id: "ses_title", updated: 1 },
          { id: "ses_body", updated: 20 },
          { id: "ses_archived", updated: 30 },
          { id: "ses_child", updated: 40 },
          { id: "ses_tools", updated: 50 },
        ]);
        const { db } = yield* Database.Service;
        const store = yield* SessionStore.Service;
        yield* db.run(
          sql`UPDATE session_v2 SET title = 'Docker PostgreSQL поиск' WHERE id = 'ses_title'`,
        );
        yield* message("ses_body", "msg_search_body", "user", {
          text: "Настройка Докера PostgreSQL и Docker",
        });
        yield* message(
          "ses_body",
          "msg_search_duplicate",
          "assistant",
          { content: [{ type: "text", text: "Docker PostgreSQL response" }] },
          2,
        );
        yield* message("ses_archived", "msg_search_archived", "user", {
          text: "Docker PostgreSQL",
        });
        yield* db.run(
          sql`UPDATE session_v2 SET time_archived = 1 WHERE id = 'ses_archived'`,
        );
        yield* message("ses_child", "msg_search_child", "user", {
          text: "Docker PostgreSQL",
        });
        yield* db.run(
          sql`UPDATE session_v2 SET parent_id = 'ses_title' WHERE id = 'ses_child'`,
        );
        yield* message("ses_tools", "msg_search_tools", "assistant", {
          content: [
            { type: "tool", text: "toolonlyneedle" },
            { type: "reasoning", text: "reasononlyneedle" },
          ],
        });
        const found = yield* store.search({ query: "docker postgre" });
        expect(
          found.map((hit) => [String(hit.session.id), hit.matchKind]),
        ).toEqual([
          ["ses_title", "title"],
          ["ses_body", "content"],
        ]);
        expect(found[1]?.snippet).toContain("Docker");
        expect(found[1]?.messageID).toBeDefined();
        expect(
          (yield* store.search({ query: "ДОКЕР" })).map(
            (hit) => hit.session.id,
          ),
        ).toEqual([Session.ID.make("ses_body")]);
        expect(
          (yield* store.search({ query: "ПОИСК" })).map(
            (hit) => hit.session.id,
          ),
        ).toEqual([Session.ID.make("ses_title")]);
        expect(
          (yield* store.search({ query: "docker", archived: true })).map(
            (hit) => hit.session.id,
          ),
        ).toEqual([Session.ID.make("ses_archived")]);
        expect(yield* store.search({ query: "toolonlyneedle" })).toEqual([]);
        expect(yield* store.search({ query: "reasononlyneedle" })).toEqual([]);
        expect(
          yield* store.search({ query: 'docker OR "missingword"' }),
        ).toEqual([]);
        expect(yield* store.search({ query: '* - : "' })).toEqual([]);
      }),
  );

  it.effect(
    "preserves literal Unicode and camel-case title substrings before content matches",
    () =>
      Effect.gen(function* () {
        yield* seedSessions([
          { id: "ses_contains", updated: 1 },
          { id: "ses_prefix", updated: 2 },
          { id: "ses_exact", updated: 3 },
          { id: "ses_body", updated: 100 },
        ]);
        const { db } = yield* Database.Service;
        const store = yield* SessionStore.Service;
        yield* db.run(
          sql`UPDATE session_v2 SET title = 'redisConfig НастройкаПОДКЛЮЧЕНИЯ' WHERE id = 'ses_contains'`,
        );
        yield* db.run(
          sql`UPDATE session_v2 SET title = 'Config setup' WHERE id = 'ses_prefix'`,
        );
        yield* db.run(
          sql`UPDATE session_v2 SET title = 'Config' WHERE id = 'ses_exact'`,
        );
        yield* db.run(
          sql`UPDATE session_v2 SET title = NULL WHERE id = 'ses_body'`,
        );
        yield* message("ses_body", "msg_substring", "user", {
          text: "Config подключения",
        });
        const found = yield* store.search({ query: "cOnFiG" });
        expect(found.map((hit) => hit.session.id)).toEqual([
          Session.ID.make("ses_exact"),
          Session.ID.make("ses_prefix"),
          Session.ID.make("ses_contains"),
          Session.ID.make("ses_body"),
        ]);
        expect(found[2]?.matchKind).toBe("title");
        expect(
          (yield* store.search({ query: "подключения" })).map(
            (hit) => hit.session.id,
          ),
        ).toEqual([
          Session.ID.make("ses_contains"),
          Session.ID.make("ses_body"),
        ]);
        expect(
          (yield* store.search({ query: "config настройка" }))[0]?.session.id,
        ).toBe(Session.ID.make("ses_contains"));
        expect(
          (yield* store.search({ query: "CONFIG", limit: 1 }))[0]?.session.id,
        ).toBe(Session.ID.make("ses_exact"));
      }),
  );

  it.effect(
    "synchronizes title, user, assistant parts, legacy fallback and cascading deletes",
    () =>
      Effect.gen(function* () {
        yield* seedSessions([{ id: "ses_changes", updated: 1 }]);
        const { db } = yield* Database.Service;
        const store = yield* SessionStore.Service;
        yield* message("ses_changes", "msg_search_user", "user", {
          text: "useroriginal",
        });
        expect(yield* store.search({ query: "useroriginal" })).toHaveLength(1);
        yield* db.run(
          sql`UPDATE session_message SET data = '{"text":"userreplacement"}' WHERE id = 'msg_search_user'`,
        );
        expect(yield* store.search({ query: "useroriginal" })).toEqual([]);
        expect(yield* store.search({ query: "userreplacement" })).toHaveLength(
          1,
        );
        yield* message(
          "ses_changes",
          "msg_search_assistant",
          "assistant",
          { content: [{ type: "text", text: "legacyfallback" }] },
          2,
        );
        expect(yield* store.search({ query: "legacyfallback" })).toHaveLength(
          1,
        );
        yield* db.run(sql`INSERT INTO session_part(message_id, session_id, ordinal, type, data, time_created, time_updated)
        VALUES ('msg_search_assistant', 'ses_changes', 0, 'reasoning', '{"type":"reasoning","text":"hiddenreasoning"}', 1, 1)`);
        expect(yield* store.search({ query: "legacyfallback" })).toEqual([]);
        expect(yield* store.search({ query: "hiddenreasoning" })).toEqual([]);
        yield* db.run(sql`INSERT INTO session_part(message_id, session_id, ordinal, type, data, time_created, time_updated)
        VALUES ('msg_search_assistant', 'ses_changes', 1, 'text', '{"type":"text","text":"partoriginal"}', 1, 1)`);
        expect(yield* store.search({ query: "partoriginal" })).toHaveLength(1);
        yield* db.run(sql`INSERT INTO session_part(message_id, session_id, ordinal, type, data, time_created, time_updated)
        VALUES ('msg_search_assistant', 'ses_changes', 2, 'text', '{"type":"text","text":"otherword"}', 1, 1)`);
        expect(
          yield* store.search({ query: "partoriginal otherword" }),
        ).toHaveLength(1);
        yield* db.run(
          sql`UPDATE session_part SET data = '{"type":"text","text":"partreplacement"}' WHERE message_id = 'msg_search_assistant' AND ordinal = 1`,
        );
        expect(yield* store.search({ query: "partoriginal" })).toEqual([]);
        expect(yield* store.search({ query: "partreplacement" })).toHaveLength(
          1,
        );
        yield* db.run(
          sql`DELETE FROM session_part WHERE message_id = 'msg_search_assistant'`,
        );
        expect(yield* store.search({ query: "partreplacement" })).toEqual([]);
        expect(yield* store.search({ query: "legacyfallback" })).toHaveLength(
          1,
        );
        yield* db.run(
          sql`UPDATE session_v2 SET title = 'renamedneedle' WHERE id = 'ses_changes'`,
        );
        expect(
          (yield* store.search({ query: "renamedneedle" }))[0]?.matchKind,
        ).toBe("title");
        yield* db.run(
          sql`DELETE FROM session_message WHERE id = 'msg_search_user'`,
        );
        expect(yield* store.search({ query: "userreplacement" })).toEqual([]);
        yield* db.run(sql`DELETE FROM session_v2 WHERE id = 'ses_changes'`);
        expect(yield* store.search({ query: "legacyfallback" })).toEqual([]);
        expect(
          yield* db.all(sql`SELECT id FROM session_search_document`),
        ).toEqual([]);
      }),
  );

  it.effect(
    "caps result counts without altering normal session-list cursors",
    () =>
      Effect.gen(function* () {
        yield* seedSessions(
          Array.from({ length: 105 }, (_, index) => ({
            id: `ses_needle_${index}`,
            updated: index,
          })),
        );
        const store = yield* SessionStore.Service;
        expect(yield* store.search({ query: "needle" })).toHaveLength(50);
        expect(yield* store.search({ query: "needle", limit: 3 })).toHaveLength(
          3,
        );
        expect(
          yield* store.search({ query: "needle", limit: 120 }),
        ).toHaveLength(100);
        expect((yield* store.list({ limit: 1 }))[0]?.id).toBe(
          Session.ID.make("ses_needle_104"),
        );
        const { db } = yield* Database.Service;
        const words = Array.from({ length: 32 }, (_, index) => `term${index}`);
        yield* db.run(
          sql`UPDATE session_v2 SET title = ${words.join(" ")} WHERE id = 'ses_needle_104'`,
        );
        expect(yield* store.search({ query: words.join(" ") })).toHaveLength(1);
        expect(
          yield* store.search({ query: words.join(" ") + " absentword" }),
        ).toEqual([]);
        expect(
          yield* store.search({ query: "needle" + " ".repeat(4096) }),
        ).toEqual([]);
      }),
  );

  it.effect(
    "backfills existing user and legacy assistant messages in a forward migration",
    () =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service;
        const triggers = yield* db.all<{ name: string }>(
          sql`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'session_search_%'`,
        );
        for (const trigger of triggers)
          yield* db.run(sql`DROP TRIGGER ${sql.identifier(trigger.name)}`);
        yield* db.run(sql`DROP TABLE session_search_fts`);
        yield* db.run(sql`DROP TABLE session_search_document`);
        yield* seedSessions([{ id: "ses_backfill", updated: 1 }]);
        yield* message("ses_backfill", "msg_search_before", "user", {
          text: "старыйтекст",
        });
        yield* message(
          "ses_backfill",
          "msg_search_legacy",
          "assistant",
          { content: [{ type: "text", text: "legacybeforeindex" }] },
          2,
        );
        yield* db.transaction((tx) => searchMigration.up(tx));
        const store = yield* SessionStore.Service;
        expect(yield* store.search({ query: "СТАРЫЙТЕКСТ" })).toHaveLength(1);
        expect(
          yield* store.search({ query: "legacybeforeindex" }),
        ).toHaveLength(1);
      }),
  );

  it.effect("indexes each streamed text-part update only once", () =>
    Effect.gen(function* () {
      yield* seedSessions([{ id: "ses_stream_search", updated: 1 }]);
      const { db } = yield* Database.Service;
      const store = yield* SessionStore.Service;
      yield* message("ses_stream_search", "msg_stream_search", "assistant", {
        content: [],
      });
      yield* db.run(sql`INSERT INTO session_part(message_id, session_id, ordinal, type, data, time_created, time_updated)
        VALUES ('msg_stream_search', 'ses_stream_search', 0, 'text', '{"type":"text","text":"initial"}', 1, 1)`);
      yield* db.run(
        sql`CREATE TEMP TABLE search_stream_probe (replacements INTEGER NOT NULL)`,
      );
      yield* db.run(sql`INSERT INTO search_stream_probe VALUES (0)`);
      yield* db.run(sql`CREATE TEMP TRIGGER search_stream_probe_insert AFTER INSERT ON main.session_search_document
        WHEN new.message_id = 'msg_stream_search' BEGIN
          UPDATE search_stream_probe SET replacements = replacements + 1;
        END`);
      for (let index = 0; index < 100; index += 1) {
        const data = JSON.stringify({
          type: "text",
          text: "stream ".repeat(1000) + `needle${index}`,
        });
        yield* db.run(
          sql`UPDATE session_part SET data = ${data} WHERE message_id = 'msg_stream_search' AND ordinal = 0`,
        );
      }
      expect(
        yield* db.all(sql`SELECT replacements FROM search_stream_probe`),
      ).toEqual([{ replacements: 100 }]);
      expect(yield* store.search({ query: "needle99" })).toHaveLength(1);
      expect(yield* store.search({ query: "needle0" })).toEqual([]);
    }),
  );
});
