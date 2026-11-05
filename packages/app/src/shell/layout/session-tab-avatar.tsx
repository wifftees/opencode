import { createMemo, Show } from "solid-js"
import { checksum } from "@opencode/util/encode"

const motifs = [
  { outline: "M10 1.5 18.5 10 10 18.5 1.5 10Z", detail: "M10 1.5V18.5M1.5 10H18.5" },
  { outline: "M10 1.5 17.4 5.8V14.2L10 18.5 2.6 14.2V5.8Z", detail: "M2.6 5.8 10 10 17.4 5.8M10 10V18.5" },
  { outline: "M10 2 18.5 17H1.5Z", detail: "M10 2V11.5L1.5 17M10 11.5 18.5 17" },
  { outline: "M18 10A8 8 0 1 1 2 10A8 8 0 1 1 18 10Z", detail: "M2 10H18M10 2C5 7 5 13 10 18C15 13 15 7 10 2Z" },
  { outline: "M2 2H8V8H2ZM12 2H18V8H12ZM2 12H8V18H2ZM12 12H18V18H12Z", detail: "M8 5H12M5 8V12M15 8V12M8 15H12" },
  {
    outline: "M10 1.5 12.6 7.4 18.5 10 12.6 12.6 10 18.5 7.4 12.6 1.5 10 7.4 7.4Z",
    detail: "M7.4 7.4 12.6 12.6M12.6 7.4 7.4 12.6",
  },
] as const

const colors = ["cyan", "blue", "purple", "pink", "green"] as const

export function SessionTabAvatarView(props: { sessionID: string; unread: boolean }) {
  const glyph = createMemo(() => {
    const seed = parseInt(checksum(props.sessionID) ?? "0", 36)

    return {
      motif: motifs[seed % motifs.length] ?? motifs[0],
      color: colors[(seed >>> 8) % colors.length] ?? colors[0],
      rotation: ((seed >>> 16) % 4) * 90,
      dot: (seed & 1) === 1,
    }
  })

  return (
    <span
      data-component="session-avatar"
      data-unread={props.unread ? "" : undefined}
      class="relative block size-4 shrink-0"
      aria-hidden="true"
      style={{ color: `var(--v2-avatar-border-${glyph().color})` }}
    >
      <svg data-slot="session-glyph" width="16" height="16" viewBox="0 0 20 20" fill="none">
        <g
          transform={`rotate(${glyph().rotation} 10 10)`}
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linejoin="round"
          stroke-linecap="round"
        >
          <path d={glyph().motif.outline} fill={`var(--v2-avatar-bg-${glyph().color})`} />
          <path d={glyph().motif.detail} />
          <Show when={glyph().dot}>
            <circle cx="10" cy="10" r="1.25" fill="var(--v2-avatar-fg)" stroke="none" />
          </Show>
        </g>
      </svg>
      <Show when={props.unread}>
        <span
          data-slot="session-avatar-unread-dot"
          class="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-v2-background-bg-accent ring-2 ring-v2-background-bg-base"
        />
      </Show>
    </span>
  )
}
