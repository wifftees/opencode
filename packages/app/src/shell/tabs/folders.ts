import { Schema } from "effect"
import { uuid } from "@opencode/util/uuid"
import { Persistence } from "@/runtime/persistence/schema"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { usePlatform } from "@/runtime/platform/platform"
import { ServerConnection, useServers } from "@/runtime/server/registry"

const Revision = { updated: Schema.Finite, writer: Schema.String }

const Folder = Schema.Struct({
  project: Schema.String,
  name: Schema.String,
  collapsed: Schema.Boolean,
  deleted: Schema.Boolean,
  ...Revision,
})

const Membership = Schema.Struct({ folder: Schema.String, ...Revision })

export const SessionFolders = Persistence.struct({
  folders: Persistence.record(Persistence.record(Folder)),
  sessions: Persistence.record(Persistence.record(Membership)),
})

export function mergeSessionFolders(local: typeof SessionFolders.Type, incoming: typeof SessionFolders.Type) {
  return {
    folders: merge(local.folders, incoming.folders),
    sessions: merge(local.sessions, incoming.sessions),
  }
}

function merge<T extends { updated: number; writer: string }>(
  local: Record<string, Record<string, T>>,
  incoming: Record<string, Record<string, T>>,
) {
  return Object.fromEntries(
    [...new Set([...Object.keys(local), ...Object.keys(incoming)])].sort().map((scope) => {
      const before = local[scope] ?? {}
      const after = incoming[scope] ?? {}

      return [
        scope,
        Object.fromEntries(
          [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().map((id) => {
            const a = before[id]
            const b = after[id]

            if (!a) return [id, b]

            if (!b) return [id, a]

            return [id, a.updated > b.updated || (a.updated === b.updated && a.writer > b.writer) ? a : b]
          }),
        ),
      ]
    }),
  )
}

export function createSessionFolders() {
  const servers = useServers()
  const platform = usePlatform()
  const writer = uuid()

  const [store, setStore, , ready] = persisted(
    { ...Persist.global("session-folders.v1"), sync: true },
    SessionFolders,
    { folders: {}, sessions: {} },
    platform,
    { merge: mergeSessionFolders },
  )

  const list = (server: ServerConnection.Key) =>
    Object.entries(store.folders[servers.scope(server)] ?? {}).flatMap(([id, folder]) =>
      folder.deleted ? [] : [{ id, ...folder }],
    )

  const get = (server: ServerConnection.Key, id: string | undefined) =>
    id ? list(server).find((folder) => folder.id === id) : undefined

  const revision = (updated = 0) => ({
    updated: Math.max(Date.now(), updated + 1),
    writer,
  })

  return {
    ready,
    list,
    get,
    folder: (server: ServerConnection.Key, sessionID: string) =>
      get(server, store.sessions[servers.scope(server)]?.[sessionID]?.folder),
    ids: (server: ServerConnection.Key) => Object.keys(store.sessions[servers.scope(server)] ?? {}),
    project: (server: ServerConnection.Key, sessionID: string) => {
      const scope = servers.scope(server)
      const id = store.sessions[scope]?.[sessionID]?.folder

      return id ? store.folders[scope]?.[id]?.project : undefined
    },
    save(server: ServerConnection.Key, project: string, name: string, id = uuid()) {
      if (!ready()) return false
      const value = name.trim()

      if (
        !value ||
        list(server).some(
          (folder) =>
            folder.project === project && folder.id !== id && folder.name.toLowerCase() === value.toLowerCase(),
        )
      )
        return false
      const scope = servers.scope(server)
      const current = store.folders[scope]?.[id]
      setStore("folders", scope, (folders = {}) => ({
        ...folders,
        [id]: {
          project,
          name: value,
          collapsed: current?.collapsed ?? false,
          deleted: false,
          ...revision(current?.updated),
        },
      }))

      return true
    },
    collapse(server: ServerConnection.Key, id: string) {
      const folder = get(server, id)

      if (!ready() || !folder) return
      setStore("folders", servers.scope(server), id, {
        collapsed: !folder.collapsed,
        ...revision(folder.updated),
      })
    },
    remove(server: ServerConnection.Key, id: string) {
      const folder = get(server, id)

      if (!ready() || !folder) return
      setStore("folders", servers.scope(server), id, {
        deleted: true,
        ...revision(folder.updated),
      })
    },
    move(server: ServerConnection.Key, sessionID: string, project: string, id?: string) {
      if (!ready() || (id && get(server, id)?.project !== project)) return
      const scope = servers.scope(server)
      setStore("sessions", scope, (sessions = {}) => ({
        ...sessions,
        [sessionID]: {
          folder: id ?? "",
          ...revision(sessions[sessionID]?.updated),
        },
      }))
    },
  }
}
