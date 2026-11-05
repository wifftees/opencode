import type { JSX } from "solid-js"
import { useDroppable } from "@dnd-kit/solid"
import { CollisionPriority, CollisionType, type CollisionDetector } from "@dnd-kit/abstract"
import { ServerConnection } from "@/runtime/server/registry"
import { pathKey } from "@/workspaces/path-key"

export type SessionDropDestination = {
  server: ServerConnection.Key
  project: string
  folderID?: string
}

export type SessionDropPreview = {
  key: string
  label: string
  message: string
  allowed: boolean
  unchanged: boolean
}

export const sessionDropKey = (destination: SessionDropDestination) =>
  JSON.stringify([destination.server, pathKey(destination.project), destination.folderID ?? ""])

export const sessionPointerCollision: CollisionDetector = ({ droppable, dragOperation }) => {
  const point = dragOperation.position.current
  const rect = droppable.shape

  if (!rect?.containsPoint(point)) return null

  return {
    id: droppable.id,
    priority: droppable.data.sessionFolder ? CollisionPriority.Low : CollisionPriority.High,
    type: CollisionType.PointerIntersection,
    value: 1 / Math.hypot(point.x - rect.center.x, point.y - rect.center.y),
  }
}

export function SessionDropTarget(props: {
  destination: SessionDropDestination
  kind?: "project" | "folder"
  preview?: SessionDropPreview
  children: JSX.Element
}) {
  const drop = useDroppable({
    get id() {
      return `session-${props.kind ?? "folder"}:${sessionDropKey(props.destination)}`
    },
    get data() {
      return { sessionFolder: true, destination: props.destination }
    },
    collisionDetector: sessionPointerCollision,
  })

  const active = () => props.preview?.key === drop.droppable.id

  return (
    <div
      ref={drop.ref}
      class="relative rounded-md"
      classList={{
        "bg-v2-background-bg-hover ring-1 ring-v2-border-border-focus": active() && props.preview?.allowed,
        "bg-v2-state-bg-error ring-1 ring-v2-state-border-error": active() && !props.preview?.allowed,
      }}
    >
      {props.children}
    </div>
  )
}
