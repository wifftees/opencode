import { Schema } from "effect"
import { Persistence } from "@/runtime/persistence/schema"

export const SessionPins = Persistence.struct({
  sessions: Persistence.record(
    Persistence.record(
      Schema.Struct({
        pinned: Schema.Boolean,
        updated: Schema.Finite,
        writer: Schema.String,
        order: Schema.optional(Schema.Finite),
      }),
    ),
  ),
})

export function mergeSessionPins(local: typeof SessionPins.Type, incoming: typeof SessionPins.Type) {
  return {
    sessions: Object.fromEntries(
      [...new Set([...Object.keys(local.sessions), ...Object.keys(incoming.sessions)])].sort().map((scope) => {
        const before = local.sessions[scope] ?? {}
        const after = incoming.sessions[scope] ?? {}

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
    ),
  }
}
