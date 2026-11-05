import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const document = "session_search_document"
const inlineText = `(SELECT group_concat(json_extract(value, '$.text'), char(10))
  FROM json_each(m.data, '$.content')
  WHERE type = 'object' AND json_extract(value, '$.type') = 'text'
    AND json_type(value, '$.text') = 'text')`
const partText = `(SELECT group_concat(text, char(10)) FROM (
  SELECT json_extract(p.data, '$.text') AS text FROM session_part p
  WHERE p.message_id = m.id AND p.type = 'text' AND json_type(p.data, '$.text') = 'text'
  ORDER BY p.ordinal
))`
const assistantText = `(CASE WHEN EXISTS (SELECT 1 FROM session_part p WHERE p.message_id = m.id)
  THEN ${partText} ELSE ${inlineText} END)`
const messageText = `(CASE WHEN m.type = 'user' AND json_type(m.data, '$.text') = 'text'
  THEN json_extract(m.data, '$.text') WHEN m.type = 'assistant' THEN ${assistantText} END)`

const messages = (id?: string) => `
  INSERT INTO ${document} (source, session_id, message_id, kind, text)
  SELECT 'message:' || m.id, m.session_id, m.id, 'content', ${messageText}
  FROM session_message m JOIN session_v2 s ON s.id = m.session_id
  WHERE ${id ? `m.id = ${id} AND` : ""} ${messageText} IS NOT NULL;`

const refreshMessage = (id: string) => `
  DELETE FROM ${document} WHERE source = 'message:' || ${id};
  ${messages(id)}`

const statements = [
  `CREATE TABLE ${document} (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL REFERENCES session_v2(id) ON DELETE CASCADE,
    message_id TEXT REFERENCES session_message(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    text TEXT NOT NULL
  )`,
  `CREATE INDEX session_search_document_session_idx ON ${document}(session_id)`,
  `CREATE INDEX session_search_document_message_idx ON ${document}(message_id)`,
  `CREATE VIRTUAL TABLE session_search_fts USING fts5(text,
    content='session_search_document', content_rowid='id', tokenize='unicode61', prefix='2 3 4')`,
  `INSERT INTO ${document}(source, session_id, kind, text)
    SELECT 'session:' || id, id, 'title', coalesce(title, '') FROM session_v2`,
  messages(),
  `INSERT INTO session_search_fts(session_search_fts) VALUES ('rebuild')`,
  `CREATE TRIGGER session_search_document_ai AFTER INSERT ON ${document} BEGIN
    INSERT INTO session_search_fts(rowid, text) VALUES (new.id, new.text);
  END`,
  `CREATE TRIGGER session_search_document_ad AFTER DELETE ON ${document} BEGIN
    INSERT INTO session_search_fts(session_search_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END`,
  `CREATE TRIGGER session_search_document_au AFTER UPDATE OF text ON ${document} BEGIN
    INSERT INTO session_search_fts(session_search_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO session_search_fts(rowid, text) VALUES (new.id, new.text);
  END`,
  `CREATE TRIGGER session_search_title_ai AFTER INSERT ON session_v2 BEGIN
    INSERT INTO ${document}(source, session_id, kind, text)
      VALUES ('session:' || new.id, new.id, 'title', coalesce(new.title, ''));
  END`,
  `CREATE TRIGGER session_search_title_au AFTER UPDATE OF title ON session_v2 BEGIN
    UPDATE ${document} SET text = coalesce(new.title, '') WHERE source = 'session:' || new.id;
  END`,
  `CREATE TRIGGER session_search_message_ai AFTER INSERT ON session_message BEGIN
    ${refreshMessage("new.id")}
  END`,
  `CREATE TRIGGER session_search_message_au AFTER UPDATE OF data, type, session_id ON session_message BEGIN
    ${refreshMessage("new.id")}
  END`,
  `CREATE TRIGGER session_search_part_ai AFTER INSERT ON session_part BEGIN
    ${refreshMessage("new.message_id")}
  END`,
  `CREATE TRIGGER session_search_part_au AFTER UPDATE OF data, type, session_id, message_id, ordinal ON session_part BEGIN
    ${refreshMessage("CASE WHEN old.message_id <> new.message_id THEN old.message_id END")}
    ${refreshMessage("new.message_id")}
  END`,
  `CREATE TRIGGER session_search_part_ad AFTER DELETE ON session_part BEGIN
    ${refreshMessage("old.message_id")}
  END`,
]

const migration = {
  id: "20261105130000_session_search",
  bootstrap: true,
  up(tx) {
    return Effect.gen(function* () {
      for (const statement of statements) yield* tx.run(statement)
    })
  },
} satisfies DatabaseMigration.Migration

export default migration
