import { expect } from "bun:test"
import { Session } from "@opencode/schema/session"
import { Effect, Schema } from "effect"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const SessionResponse = Schema.Struct({ data: Schema.toEncoded(Session.Info) })
const SessionsResponse = Schema.Struct({ data: Schema.Array(Schema.toEncoded(Session.Info)) })

const makeRequest = Effect.fn(function* () {
  const handler = yield* ServerFetch.make({
    app: { version: "test" },
    database: { path: ":memory:" },
    fs: { filewatcher: false },
    models: { fetch: false },
  })
  return (path: string, method: string, body?: unknown) =>
    Effect.promise(async () => {
      const response = await handler(
        new Request(`http://opencode.local${path}`, {
          method,
          headers: { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      )
      expect(response.status).toBe(method === "PATCH" ? 204 : 200)
      return response.status === 204 ? undefined : response.json()
    })
})

it.live("updates session metadata through PATCH", () =>
  Effect.gen(function* () {
    const request = yield* makeRequest()
    const created = Schema.decodeUnknownSync(SessionResponse)(
      yield* request("/api/session", "POST", { metadata: { source: "create", stale: true } }),
    )
    yield* request(`/api/session/${created.data.id}`, "PATCH", { metadata: { source: "patch" } })
    const updated = Schema.decodeUnknownSync(SessionResponse)(yield* request(`/api/session/${created.data.id}`, "GET"))

    expect(updated.data.metadata).toEqual({ source: "patch" })
  }).pipe(Effect.scoped),
)

it.live("archives and unarchives a session through PATCH", () =>
  Effect.gen(function* () {
    const request = yield* makeRequest()
    const created = Schema.decodeUnknownSync(SessionResponse)(yield* request("/api/session", "POST", {}))
    const get = () =>
      request(`/api/session/${created.data.id}`, "GET").pipe(
        Effect.map((body) => Schema.decodeUnknownSync(SessionResponse)(body).data),
      )
    const listed = (archived: boolean) =>
      request(`/api/session?archived=${archived}`, "GET").pipe(
        Effect.map((body) => Schema.decodeUnknownSync(SessionsResponse)(body).data.map((item) => item.id)),
      )

    yield* request(`/api/session/${created.data.id}`, "PATCH", { archived: true })
    expect((yield* get()).time.archived).toBeNumber()
    expect(yield* listed(true)).toContain(created.data.id)
    expect(yield* listed(false)).not.toContain(created.data.id)

    yield* request(`/api/session/${created.data.id}`, "PATCH", { archived: false })
    expect((yield* get()).time.archived).toBeUndefined()
    expect(yield* listed(false)).toContain(created.data.id)
  }).pipe(Effect.scoped),
)

it.live("searches session titles through the capped root-only text-search endpoint", () =>
  Effect.gen(function* () {
    const request = yield* makeRequest()
    const created = Schema.decodeUnknownSync(SessionResponse)(
      yield* request("/api/session", "POST", { title: "Поиск Docker PostgreSQL" }),
    ).data
    yield* request("/api/session", "POST", { title: "Docker child", parentID: created.id })
    const archived = Schema.decodeUnknownSync(SessionResponse)(
      yield* request("/api/session", "POST", { title: "Docker archived" }),
    ).data
    yield* request(`/api/session/${archived.id}`, "PATCH", { archived: true })
    const response = Schema.decodeUnknownSync(
      Schema.Struct({ data: Schema.Array(Schema.toEncoded(Session.SearchResult)) }),
    )(yield* request(`/api/session/search?query=${encodeURIComponent("ДОКЕР OR")}`, "GET"))
    expect(response.data).toEqual([])
    const matches = Schema.decodeUnknownSync(
      Schema.Struct({ data: Schema.Array(Schema.toEncoded(Session.SearchResult)) }),
    )(yield* request("/api/session/search?query=DOCKER%20postgre&limit=1", "GET"))
    expect(matches.data).toHaveLength(1)
    expect(matches.data[0]).toMatchObject({ session: { id: created.id }, matchKind: "title" })
    expect(matches.data[0]?.score).toBeGreaterThan(0)
    const archives = Schema.decodeUnknownSync(
      Schema.Struct({ data: Schema.Array(Schema.toEncoded(Session.SearchResult)) }),
    )(yield* request("/api/session/search?query=docker&archived=true", "GET"))
    expect(archives.data.map((hit) => hit.session.id)).toEqual([archived.id])
  }).pipe(Effect.scoped),
)

it.live("rejects an invalid search limit without treating search as a session ID", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
      models: { fetch: false },
    })
    const response = yield* Effect.promise(() =>
      handler(new Request("http://opencode.local/api/session/search?query=word&limit=0")),
    )
    expect(response.status).toBe(400)
  }).pipe(Effect.scoped),
)
