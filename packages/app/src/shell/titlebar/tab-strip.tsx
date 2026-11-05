import { createEffect, createMemo, createResource, For, onCleanup, onMount, Show } from "solid-js"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { createStore } from "solid-js/store"
import { DragDropProvider, PointerSensor } from "@dnd-kit/solid"
import { isSortable, useSortable } from "@dnd-kit/solid/sortable"
import { Accessibility, AutoScroller, Feedback, PointerActivationConstraints } from "@dnd-kit/dom"
import { RestrictToHorizontalAxis, RestrictToVerticalAxis } from "@dnd-kit/abstract/modifiers"
import { RestrictToElement } from "@dnd-kit/dom/modifiers"
import { arrayMove } from "@/runtime/array-move"
import { tabHref, tabKey, type SessionTab, type Tab } from "@/shell/tabs/tabs"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { DraftTabItem, TabNavItem } from "@/shell/titlebar/tab-nav"
import { useGlobal, useServerCtx, type ServerCtx } from "@/runtime/server/runtime"
import { useLanguage } from "@/runtime/i18n/language"
import { useCommand } from "@/shell/commands/command"
import { useTabs } from "@/shell/tabs/tabs"
import { useSessionTabAvatarState } from "@/shell/layout/project-avatar-state"
import { createTabComposerState } from "@/composer/persistence"
import { base64Encode } from "@opencode/util/encode"
import { showToast } from "@/shell/notifications/toast"
import { adjacentTabKey, mergeVisibleTabOrder } from "./tab-order"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { sessionTreeIDs } from "@/session/requests/session-request-tree"
import { sessionTitle } from "@/session/title"
import { errorMessage } from "@/shell/layout/helpers"
import { notifySessionTabsRemoved } from "./session-events"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { displayName } from "@opencode/ui/project-avatar"
import { pathKey } from "@/workspaces/path-key"
import { FolderNameDialog, SessionFolderGroup } from "./session-folders"
import {
  SessionDropTarget,
  sessionDropKey,
  sessionPointerCollision,
  type SessionDropDestination,
  type SessionDropPreview,
} from "./session-drop-target"
import { setSidebarUnread } from "@/shell/sidebar-peek"
import type { SessionInfo } from "@opencode/client/promise"
import { Schema } from "effect"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { Persistence } from "@/runtime/persistence/schema"

export const previousSessionCommand = {
  id: "session.previous",
  keybind: "alt+arrowup",
}

export const nextSessionCommand = {
  id: "session.next",
  keybind: "alt+arrowdown",
}

function SessionTabSlot(props: {
  tab: SessionTab
  id: string
  index: number
  group: string
  active: boolean
  orientation: "horizontal" | "vertical"
  session: SessionInfo | undefined
  pinned?: boolean
  closable?: boolean
  preparing: boolean
  unread: boolean
  attention: boolean
  loading: boolean
  fallbackTitle?: string
  fallbackDirectory?: string
  onRename: (title: string) => Promise<void>
  onDelete: () => void
  onNavigate: (element: HTMLDivElement) => void
  onClose: () => void
  onIntent: (hovered: boolean) => void
}) {
  const sortable = useSortable({
    get id() {
      return props.id
    },
    get index() {
      return props.index
    },
    get group() {
      return props.group
    },
    get data() {
      return { sessionTabGroup: props.group }
    },
    accept: (source) => source.data.sessionTabGroup === props.group,
    collisionDetector: sessionPointerCollision,
  })

  let ref!: HTMLDivElement

  return (
    <div
      ref={sortable.ref}
      data-titlebar-tab-slot
      data-tab-key={props.id}
      data-active={props.active}
      data-orientation={props.orientation}
      class="relative flex"
      classList={{
        "w-56 min-w-7 max-w-56 flex-shrink": props.orientation === "horizontal",
        "w-full shrink-0": props.orientation === "vertical",
      }}
      onPointerEnter={() => props.onIntent(true)}
      onPointerLeave={() => props.onIntent(false)}
    >
      <TabNavItem
        ref={(el) => {
          ref = el
        }}
        href={tabHref(props.tab)}
        server={props.tab.server}
        sessionID={props.tab.sessionId}
        session={props.session}
        pinned={props.pinned}
        closable={props.closable}
        preparing={props.preparing}
        unread={props.unread}
        attention={props.attention}
        loading={props.loading}
        fallbackTitle={props.fallbackTitle}
        fallbackDirectory={props.fallbackDirectory}
        onRename={props.onRename}
        onDelete={props.onDelete}
        onNavigate={() => props.onNavigate(ref)}
        onClose={props.onClose}
        active={props.active}
        dragging={sortable.isDragSource()}
        orientation={props.orientation}
      />
    </div>
  )
}

function SessionTabEntry(props: {
  tab: SessionTab
  pinned?: boolean
  retained?: boolean
  currentTab?: Tab
  id: string
  index: number
  group: string
  active: boolean
  orientation: "horizontal" | "vertical"
  serverCtx: ServerCtx | undefined
  onVisibleChange: (visible: boolean) => void
  onUnreadChange: (unread: boolean) => void
  onNavigate: (element: HTMLDivElement) => void
  onClose: () => void
}) {
  const tabs = useTabs()
  const language = useLanguage()
  const dialog = useDialog()
  const sdk = createMemo(() => props.serverCtx?.sdk ?? null)
  const pending = createMemo(() => tabs.pendingSession(props.tab.server, props.tab.sessionId))
  const cachedSession = createMemo(() => props.serverCtx?.data.session.get(props.tab.sessionId))
  const persisted = createMemo(() => tabs.info[props.id])
  const open = createMemo(() => tabs.store.some((tab) => tabKey(tab) === props.id))

  const status = useSessionTabAvatarState(
    () => props.tab.server,
    () => props.tab.sessionId,
    () => true,
  )

  // A busy session shows its progress indicator instead of the unread dot.
  const unread = createMemo(() => status.unread() && !status.loading())

  const [loadedSession] = createResource(
    () => {
      if (pending() || (!props.pinned && !props.retained && !props.active && persisted()?.title)) return null
      const ctx = props.serverCtx

      return ctx ? { id: props.tab.sessionId, ctx } : null
    },
    ({ id, ctx }) =>
      ctx.data.session
        .sync(id)
        .then(() => ctx.data.session.get(id))
        .catch(() => undefined),
  )

  const session = createMemo(() =>
    pending()
      ? undefined
      : (cachedSession() ??
        (loadedSession.state === "ready" || loadedSession.state === "refreshing" ? loadedSession.latest : undefined)),
  )

  const missingSession = createMemo(() => !pending() && !!props.serverCtx && !loadedSession.loading && !session())

  const visible = createMemo(() => {
    if (pending()) return true

    if (props.pinned || props.retained) return !!session() && !session()?.time.archived && !session()?.parentID

    return !!pending() || !!session() || missingSession() || !!persisted()?.title
  })

  createEffect(() => {
    const ctx = props.serverCtx

    if (!ctx) return
    onCleanup(
      ctx.data.on("session.deleted", (event) => {
        if (
          event.data.sessionID !== props.tab.sessionId ||
          !tabs.sessionPins.isPinned(props.tab.server, props.tab.sessionId)
        )
          return
        tabs.sessionPins.set(props.tab.server, props.tab.sessionId, false)
      }),
    )
  })

  const rename = async (title: string) => {
    const value = session()
    const ctx = props.serverCtx

    if (!value || !ctx) return

    ctx.data.session.remember({ ...value, title })

    try {
      await ctx.sdk.api.session.update({ sessionID: value.id, title })
    } catch (err) {
      const current = session()
      const currentCtx = props.serverCtx

      // A newer rename may have replaced this title while the save was in flight.
      if (current && currentCtx && current.title === title)
        currentCtx.data.session.remember({ ...current, title: value.title })
      showToast({
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : undefined,
      })
    }
  }

  function DeleteDialog() {
    const confirm = async () => {
      const value = session()
      const ctx = props.serverCtx

      dialog.close()

      if (!value || !ctx) return
      const ids = sessionTreeIDs(ctx.data.session.list(), value.id)

      try {
        await ctx.data.session.remove(value.id)
        notifySessionTabsRemoved({
          server: props.tab.server,
          directory: value.location.directory,
          sessionIDs: ids,
        })
      } catch (cause) {
        showToast({
          title: language.t("session.delete.failed.title"),
          description: errorMessage(cause, language.t("session.delete.failed.title")),
        })
      }
    }

    return (
      <Dialog fit>
        <DialogHeader hideClose>
          <DialogTitleGroup
            title={language.t("session.delete.title")}
            description={language.t("session.delete.confirm", {
              name: sessionTitle(session()?.title) ?? language.t("session.tab.session"),
            })}
          />
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" autofocus onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button variant="danger" onClick={confirm}>
            {language.t("session.delete.button")}
          </Button>
        </DialogFooter>
      </Dialog>
    )
  }

  createEffect(() => props.onVisibleChange(visible()))
  createEffect(() => props.onUnreadChange(unread()))

  createEffect(() => {
    const ctx = props.serverCtx
    const id = props.tab.sessionId

    if (
      pending() ||
      !open() ||
      !ctx ||
      props.active ||
      ctx.data.session.missing(id) ||
      (!session() && !persisted()?.title) ||
      ctx.sdk.connection.status() !== "connected"
    )
      return

    const current = props.currentTab

    if (current?.type === "session" && current.server === props.tab.server && current.sessionId !== id) {
      const active = ctx.data.session.get(current.sessionId)

      if (
        !active ||
        ctx.data.location.agent.list(active.location) === undefined ||
        ctx.data.location.provider.list(active.location) === undefined ||
        ctx.data.location.model.list(active.location) === undefined ||
        ctx.data.location.skill.list(active.location) === undefined
      )
        return
    }

    const running = [id, ...ctx.data.session.family(id)].some(
      (sessionID) => ctx.data.session.status(sessionID) === "running",
    )

    const timer = window.setTimeout(
      () =>
        void Promise.allSettled([
          ctx.data.session.sync(id, { children: true }),
          // The selected timeline loads the transcript; inactive tabs need metadata and the inbox,
          // whose waiting work keeps the tab busy. Only a running session can wait on a permission
          // or form, and reading either boots the session's location on the server.
          ...(running ? [ctx.data.session.permission.sync(id), ctx.data.session.form.sync(id)] : []),
          ctx.data.session.pending.sync(id),
        ]),
      300 + props.index * 50,
    )

    onCleanup(() => window.clearTimeout(timer))
  })

  // A pointer resting on a tab usually clicks it next, so its transcript loads during the dwell. Passing over loads nothing.
  let intent: number | undefined

  const hover = (hovered: boolean) => {
    window.clearTimeout(intent)
    const ctx = props.serverCtx
    const value = session()

    if (!hovered || !ctx || !value || props.active || ctx.sdk.connection.status() !== "connected") return
    intent = window.setTimeout(() => void ctx.data.session.message.sync(value.id).catch(() => undefined), 100)
  }

  onCleanup(() => window.clearTimeout(intent))

  createEffect(() => {
    const value = session()

    if (!value || !open()) return
    tabs.rememberSessionInfo(
      props.tab,
      value,
      props.serverCtx?.data.session.message.list(value.id).some((message) => message.type === "user") ?? false,
    )
    const current = sdk()

    if (!current) return
    createTabComposerState(tabs, props.tab, current.scope, {
      dir: base64Encode(value.location.directory),
      id: value.id,
    })
  })

  return (
    <Show when={visible()}>
      <SessionTabSlot
        tab={props.tab}
        id={props.id}
        index={props.index}
        group={props.group}
        active={props.active}
        orientation={props.orientation}
        session={session()}
        pinned={props.pinned}
        closable={open()}
        preparing={!!pending()}
        unread={unread()}
        attention={status.attention()}
        loading={status.loading()}
        fallbackTitle={
          pending()
            ? language.t("session.tab.session")
            : (persisted()?.title ?? (missingSession() ? language.t("session.tab.unknown") : undefined))
        }
        fallbackDirectory={pending()?.draft.directory ?? persisted()?.directory}
        onRename={rename}
        onDelete={() => dialog.show(() => <DeleteDialog />)}
        onNavigate={props.onNavigate}
        onClose={props.onClose}
        onIntent={hover}
      />
    </Show>
  )
}

function DraftTabSlot(props: {
  tab: Extract<Tab, { type: "draft" }>
  id: string
  index: number
  group: string
  active: boolean
  orientation: "horizontal" | "vertical"
  title: string
  onNavigate: (element: HTMLDivElement) => void
  onClose: () => void
}) {
  const sortable = useSortable({
    get id() {
      return props.id
    },
    get index() {
      return props.index
    },
    get group() {
      return props.group
    },
    get data() {
      return { sessionTabGroup: props.group }
    },
    accept: (source) => source.data.sessionTabGroup === props.group,
    collisionDetector: sessionPointerCollision,
  })

  let ref!: HTMLDivElement

  return (
    <div
      ref={sortable.ref}
      data-titlebar-tab-slot
      data-tab-key={props.id}
      data-active={props.active}
      data-orientation={props.orientation}
      class="relative flex"
      classList={{
        "w-56 min-w-7 max-w-56 flex-shrink": props.orientation === "horizontal",
        "w-full shrink-0": props.orientation === "vertical",
      }}
    >
      <DraftTabItem
        ref={(el) => {
          ref = el
        }}
        href={tabHref(props.tab)}
        title={props.title}
        onNavigate={() => props.onNavigate(ref)}
        onClose={props.onClose}
        active={props.active}
        dragging={sortable.isDragSource()}
        orientation={props.orientation}
      />
    </div>
  )
}

export function TitlebarTabStrip(props: {
  orientation?: "horizontal" | "vertical"
  tabs: Tab[]
  currentTab: Tab | undefined
  onNavigate: (tab: Tab, el?: HTMLDivElement) => void
  onClose: (tab: Tab) => void
  onReorder: (keys: string[]) => void
}) {
  const global = useGlobal()
  const language = useLanguage()
  const command = useCommand()
  const tabs = useTabs()
  const pins = tabs.sessionPins
  const folders = tabs.sessionFolders
  const dialog = useDialog()
  const servers = useServers()

  const [sections, setSections, , sectionsReady] = persisted(
    Persist.window("session-sections.v1"),
    Persistence.struct({ collapsed: Persistence.record(Schema.Boolean) }),
    { collapsed: {} },
  )

  const sectionKey = (server: ServerConnection.Key, directory: string, kind: "project" | "unfiled") =>
    JSON.stringify([servers.scope(server), pathKey(directory), kind])

  const toggleSection = (key: string) => {
    if (sectionsReady()) setSections("collapsed", key, !sections.collapsed[key])
  }

  const vertical = () => props.orientation === "vertical"

  const actualProjectFor = (tab: Tab) => {
    const ctx = global.serverCtx(tab.server)
    const session = tab.type === "session" ? ctx?.data.session.get(tab.sessionId) : undefined

    const directory =
      tab.type === "draft" ? tab.directory : (session?.location.directory ?? tabs.info[tabKey(tab)]?.directory)

    const project = session
      ? ctx?.projects.forSession(session)
      : directory
        ? ctx?.projects.forDirectory(directory)
        : undefined

    return project?.worktree ?? directory
  }

  const folderFor = (tab: Tab) => {
    const folder =
      tab.type === "draft" ? folders.get(tab.server, tab.folderID) : folders.folder(tab.server, tab.sessionId)

    const project = actualProjectFor(tab)

    return folder && (!project || pathKey(project) === pathKey(folder.project)) ? folder : undefined
  }

  const pinned = (tab: Tab) =>
    vertical() && tab.type === "session" && pins.isPinned(tab.server, tab.sessionId) && !folderFor(tab)

  const pinnedTabs = createMemo(() =>
    !vertical() || !pins.ready()
      ? []
      : global.servers.list().flatMap((conn) => {
          const server = ServerConnection.key(conn)

          return pins
            .ids(server)
            .filter((id) => !folders.folder(server, id))
            .map((sessionId): SessionTab => {
              const open = props.tabs.find(
                (tab) => tab.type === "session" && tab.server === server && tab.sessionId === sessionId,
              )

              return open?.type === "session" ? open : { type: "session", server, sessionId }
            })
        }),
  )

  const folderTabs = createMemo(() =>
    !vertical() || !folders.ready()
      ? []
      : global.servers.list().flatMap((conn) => {
          const server = ServerConnection.key(conn)

          return folders.ids(server).map((sessionId): SessionTab => {
            const open = props.tabs.find(
              (tab) => tab.type === "session" && tab.server === server && tab.sessionId === sessionId,
            )

            return open?.type === "session" ? open : { type: "session", server, sessionId }
          })
        }),
  )

  const ordinaryTabs = createMemo(() => {
    const entries = new Map(props.tabs.filter((tab) => !pinned(tab)).map((tab) => [tabKey(tab), tab]))

    for (const tab of folderTabs()) if (!pinned(tab) && !entries.has(tabKey(tab))) entries.set(tabKey(tab), tab)

    return [...entries.values()]
  })

  const projectFor = (tab: Tab) =>
    actualProjectFor(tab) ??
    folderFor(tab)?.project ??
    (tab.type === "session" ? folders.project(tab.server, tab.sessionId) : undefined)

  const destinationFor = (tab: Tab): SessionDropDestination | undefined => {
    const project = projectFor(tab)

    return project ? { server: tab.server, project, folderID: folderFor(tab)?.id } : undefined
  }

  const groupFor = (tab: Tab) =>
    !vertical()
      ? "tabs"
      : pinned(tab)
        ? `pinned:${tab.server}`
        : sessionDropKey(destinationFor(tab) ?? { server: tab.server, project: "" })

  const projectViews = new Map<
    string,
    { server: ServerConnection.Key; directory: string; readonly name: string; readonly tabs: Tab[] }
  >()

  const projects = createMemo(() =>
    global.servers.list().flatMap((conn) => {
      const server = ServerConnection.key(conn)
      const ctx = global.serverCtx(server)

      const directories = new Set([
        ...(ctx?.projects.used().map((project) => project.worktree) ?? []),
        ...folders.list(server).map((folder) => folder.project),
        ...ordinaryTabs().flatMap((tab) => (tab.server === server ? (projectFor(tab) ?? []) : [])),
      ])

      return [...directories].flatMap((directory) => {
        if (ctx?.projects.hidden(directory)) return []

        const key = JSON.stringify([server, directory])
        const existing = projectViews.get(key)

        if (existing) return [existing]

        const view = {
          server,
          directory,
          get name() {
            return displayName(ctx?.projects.forDirectory(directory) ?? { worktree: directory })
          },
          get tabs() {
            return ordinaryTabs().filter(
              (tab) => tab.server === server && pathKey(projectFor(tab) ?? "") === pathKey(directory),
            )
          },
        }

        projectViews.set(key, view)

        return [view]
      })
    }),
  )

  const orderedTabs = createMemo(() =>
    !vertical()
      ? ordinaryTabs()
      : [
          ...pinnedTabs(),
          ...projects().flatMap((project) => [
            ...folders
              .list(project.server)
              .filter((folder) => folder.project === project.directory)
              .flatMap((folder) => project.tabs.filter((tab) => folderFor(tab)?.id === folder.id)),
            ...project.tabs.filter((tab) => !folderFor(tab)),
          ]),
          ...ordinaryTabs().filter((tab) => !projectFor(tab)),
        ],
  )

  let listRef!: HTMLDivElement
  let scrollRef!: HTMLDivElement
  // Each vertical edge feathers by as much as there is left to scroll past it, so it appears and leaves without a jump.
  const [fade, setFade] = createStore({ top: 0, bottom: 0 })

  const measureFade = () =>
    setFade({
      top: Math.min(16, Math.round(scrollRef.scrollTop)),
      bottom: Math.min(
        16,
        Math.max(0, Math.round(scrollRef.scrollHeight - scrollRef.clientHeight - scrollRef.scrollTop)),
      ),
    })

  onMount(() => {
    if (vertical()) createResizeObserver([scrollRef, listRef], measureFade)
  })
  const [visibility, setVisibility] = createStore<Record<string, boolean>>({})
  const [unread, setUnread] = createStore<Record<string, boolean>>({})

  const visibleTabs = createMemo(() =>
    orderedTabs().filter((tab) => {
      if (tab.type !== "draft" && !visibility[tabKey(tab)]) return false

      if (!vertical()) return true

      if (pinned(tab)) return !sections.collapsed.pinned

      if (folderFor(tab)?.collapsed) return false
      const directory = projectFor(tab)

      if (!directory) return true

      if (sections.collapsed[sectionKey(tab.server, directory, "project")]) return false

      return !!folderFor(tab) || !sections.collapsed[sectionKey(tab.server, directory, "unfiled")]
    }),
  )

  const visibleTabIds = () => visibleTabs().map(tabKey)

  // Tells the closed sidebar's toggle whether any row here shows its unread dot, which the current tab never does.
  createEffect(() => {
    if (!vertical()) return
    setSidebarUnread(orderedTabs().some((tab) => tab !== props.currentTab && !!unread[tabKey(tab)]))
    onCleanup(() => setSidebarUnread(false))
  })

  command.register("titlebar-tab-cycle", () => [
    {
      id: `tab.prev`,
      category: "tab",
      title: "",
      keybind: `mod+option+ArrowLeft,ctrl+shift+tab`,
      hidden: true,
      onSelect: () => selectAdjacentTab(-1),
    },
    {
      id: `tab.next`,
      category: "tab",
      title: "",
      keybind: `mod+option+ArrowRight,ctrl+tab`,
      hidden: true,
      onSelect: () => selectAdjacentTab(1),
    },
    {
      ...previousSessionCommand,
      category: language.t("command.category.session"),
      title: language.t("command.session.previous"),
      onSelect: () => selectAdjacentTab(-1),
    },
    {
      ...nextSessionCommand,
      category: language.t("command.category.session"),
      title: language.t("command.session.next"),
      onSelect: () => selectAdjacentTab(1),
    },
    {
      id: "session.previous.unseen",
      category: language.t("command.category.session"),
      title: language.t("command.session.previous.unseen"),
      keybind: "shift+alt+arrowup",
      onSelect: () => selectAdjacentTab(-1, (key) => !!unread[key]),
    },
    {
      id: "session.next.unseen",
      category: language.t("command.category.session"),
      title: language.t("command.session.next.unseen"),
      keybind: "shift+alt+arrowdown",
      onSelect: () => selectAdjacentTab(1, (key) => !!unread[key]),
    },
  ])

  // One registration numbers the visible tabs, so a reorder, a close or a tab coming into view never leaves two tabs
  // holding the same number while their owners update.
  const tabRefs = new Map<string, () => HTMLDivElement | undefined>()

  command.register("titlebar-tab-numbers", () =>
    visibleTabs()
      .slice(0, 9)
      .map((tab, index) => ({
        id: `tab.${index + 1}`,
        category: "tab",
        title: "",
        keybind: `mod+${index + 1}`,
        hidden: true,
        onSelect: () => props.onNavigate(tab, tabRefs.get(tabKey(tab))?.()),
      })),
  )

  function selectAdjacentTab(offset: -1 | 1, include?: (key: string) => boolean) {
    const current = props.currentTab
    const key = adjacentTabKey(visibleTabIds(), current ? tabKey(current) : undefined, offset, include)
    const next = orderedTabs().find((tab) => tabKey(tab) === key)

    if (next) props.onNavigate(next)
  }

  const renderTab = (tab: Tab) => {
    const id = tabKey(tab)
    let ref!: HTMLDivElement

    const visibleIndex = () =>
      visibleTabs()
        .filter((item) => groupFor(item) === groupFor(tab))
        .findIndex((item) => tabKey(item) === id)

    const element = () => ref
    tabRefs.set(id, element)
    onCleanup(() => {
      if (tabRefs.get(id) === element) tabRefs.delete(id)
    })

    const serverCtx = useServerCtx(() => {
      if (tab.type !== "session") return

      return global.servers.list().find((item) => ServerConnection.key(item) === tab.server)
    })

    if (tab.type === "session") {
      return (
        <SessionTabEntry
          tab={tab}
          pinned={vertical() && pins.isPinned(tab.server, tab.sessionId)}
          retained={vertical() && folderTabs().some((item) => tabKey(item) === id)}
          currentTab={props.currentTab}
          id={id}
          index={visibleIndex()}
          group={groupFor(tab)}
          active={!!props.currentTab && tabKey(props.currentTab) === id}
          orientation={vertical() ? "vertical" : "horizontal"}
          serverCtx={serverCtx()}
          onVisibleChange={(visible) => setVisibility(id, visible)}
          onUnreadChange={(value) => setUnread(id, value)}
          onNavigate={(element) => {
            ref = element
            props.onNavigate(tab, element)
          }}
          onClose={() => props.onClose(tab)}
        />
      )
    }

    return (
      <DraftTabSlot
        tab={tab}
        id={id}
        index={visibleIndex()}
        group={groupFor(tab)}
        active={!!props.currentTab && tabKey(props.currentTab) === id}
        orientation={vertical() ? "vertical" : "horizontal"}
        title={language.t("session.tab.session")}
        onNavigate={(element) => {
          ref = element
          props.onNavigate(tab, element)
        }}
        onClose={() => props.onClose(tab)}
      />
    )
  }

  const [drag, setDrag] = createStore<{
    source?: string
    target?: SessionDropDestination
    targetID?: string
    row: boolean
  }>({
    row: false,
  })

  const [moving, setMoving] = createStore<Record<string, SessionDropDestination | undefined>>({})

  const destinationLabel = (destination: SessionDropDestination) => {
    const project = global.serverCtx(destination.server)?.projects.forDirectory(destination.project)
    const name = displayName(project ?? { worktree: destination.project })

    return `${name} › ${folders.get(destination.server, destination.folderID)?.name ?? language.t("session.folders.none")}`
  }

  const busy = (tab: SessionTab) => {
    const ctx = global.serverCtx(tab.server)

    return (
      !!tabs.pendingSession(tab.server, tab.sessionId) ||
      (!!ctx &&
        [tab.sessionId, ...ctx.data.session.family(tab.sessionId)].some(
          (id) => ctx.data.session.status(id) === "running" || ctx.data.session.pending.list(id).length > 0,
        ))
    )
  }

  const previewFor = (tab: Tab, destination: SessionDropDestination, row = false): SessionDropPreview => {
    const label = destinationLabel(destination)
    const cross = pathKey(projectFor(tab) ?? "") !== pathKey(destination.project)
    const unchanged = !cross && folderFor(tab)?.id === destination.folderID
    const ctx = global.serverCtx(tab.server)

    const reason =
      tab.server !== destination.server
        ? language.t("session.move.server")
        : moving[tabKey(tab)]
          ? language.t("session.move.pending")
          : cross && tab.type === "session" && busy(tab)
            ? language.t("session.move.busy")
            : cross && tab.type === "session" && !ctx?.data.session.get(tab.sessionId)
              ? language.t("session.move.loading")
              : cross && tab.type === "session" && ctx?.sdk.connection.status() !== "connected"
                ? language.t("session.move.disconnected")
                : undefined

    return {
      key: sessionDropKey(destination),
      label,
      allowed: !reason,
      unchanged,
      message:
        reason ??
        language.t(unchanged ? (row ? "session.move.reorder" : "session.move.unchanged") : "session.move.preview", {
          destination: label,
        }),
    }
  }

  const dragPreview = createMemo(() => {
    const tab = orderedTabs().find((item) => tabKey(item) === drag.source)

    return tab && drag.target
      ? {
          ...previewFor(tab, drag.target, drag.row),
          key: drag.targetID ?? `session-folder:${sessionDropKey(drag.target)}`,
        }
      : undefined
  })

  const dragChangesContext = () => {
    const tab = orderedTabs().find((item) => tabKey(item) === drag.source)

    return !!tab && !!drag.target && pathKey(projectFor(tab) ?? "") !== pathKey(drag.target.project)
  }

  const expandDestination = (destination: SessionDropDestination) => {
    setSections("collapsed", sectionKey(destination.server, destination.project, "project"), false)

    if (!destination.folderID)
      setSections("collapsed", sectionKey(destination.server, destination.project, "unfiled"), false)
    const folder = folders.get(destination.server, destination.folderID)

    if (folder?.collapsed) folders.collapse(destination.server, folder.id)
  }

  createEffect(() => {
    for (const [key, destination] of Object.entries(moving)) {
      if (!destination) continue
      const tab = orderedTabs().find((item) => tabKey(item) === key)

      if (!tab || tab.type !== "session") continue
      const ctx = global.serverCtx(tab.server)
      const info = ctx?.data.session.get(tab.sessionId)

      if (!info || pathKey(info.location.directory) !== pathKey(destination.project)) continue
      const folder = folders.get(tab.server, destination.folderID)
      folders.move(
        tab.server,
        tab.sessionId,
        destination.project,
        folder?.project === destination.project ? folder.id : undefined,
      )
      ctx?.projects.touch(destination.project)
      expandDestination(destination)
      setMoving(key, undefined)
      showToast({ title: language.t("session.move.completed", { destination: destinationLabel(destination) }) })
    }
  })

  const moveTo = async (tab: Tab, destination: SessionDropDestination) => {
    const preview = previewFor(tab, destination)

    if (!preview.allowed) {
      showToast({ title: language.t("session.move.failed"), description: preview.message })

      return
    }

    if (preview.unchanged) return
    const cross = pathKey(projectFor(tab) ?? "") !== pathKey(destination.project)

    if (tab.type === "draft") {
      tabs.updateDraft(
        tab.draftID,
        cross
          ? {
              directory: destination.project,
              folderID: destination.folderID,
              worktree: undefined,
              branch: undefined,
              mcp: undefined,
            }
          : { folderID: destination.folderID },
      )
      expandDestination(destination)

      return
    }

    if (!cross) {
      folders.move(tab.server, tab.sessionId, destination.project, destination.folderID)
      expandDestination(destination)

      return
    }

    const ctx = global.serverCtx(tab.server)

    if (!ctx) return
    const key = tabKey(tab)
    setMoving(key, destination)

    try {
      await ctx.data.session.sync(tab.sessionId, { children: true })

      const [active, pending] = await Promise.all([
        ctx.sdk.api.session.active(),
        ctx.sdk.api.session.inbox.list({ sessionID: tab.sessionId }),
      ])

      if (
        busy(tab) ||
        pending.length ||
        [tab.sessionId, ...ctx.data.session.family(tab.sessionId)].some((id) => active[id])
      ) {
        setMoving(key, undefined)
        showToast({ title: language.t("session.move.failed"), description: language.t("session.move.busy") })

        return
      }

      await ctx.sdk.api.session.move({ sessionID: tab.sessionId, directory: destination.project, delivery: "queue" })
      const info = await ctx.sdk.api.session.get({ sessionID: tab.sessionId }).catch(() => undefined)

      if (info) ctx.data.session.remember(info)
    } catch (error) {
      if (!moving[key]) return
      setMoving(key, undefined)
      showToast({
        title: language.t("session.move.failed"),
        description: errorMessage(error, language.t("session.move.failed")),
      })
    }
  }

  const pendingMove = () => Object.values(moving).find((destination) => !!destination)

  const pendingMoveLabel = () => {
    const destination = pendingMove()

    return destination ? destinationLabel(destination) : ""
  }

  return (
    <div
      data-slot={vertical() ? "vertical-tabs" : "titlebar-tabs"}
      data-orientation={vertical() ? "vertical" : "horizontal"}
      class="relative min-w-0"
      classList={{ "min-h-0 overflow-hidden": vertical() }}
    >
      <div
        ref={scrollRef}
        data-slot={vertical() ? "vertical-tabs-scroll" : "titlebar-tabs-scroll"}
        class="flex min-w-0 no-scrollbar [app-region:no-drag]"
        classList={{
          "flex-row items-center gap-1.5 overflow-x-auto": !vertical(),
          "max-h-full flex-col overflow-y-auto overflow-x-hidden": vertical(),
        }}
        style={
          vertical()
            ? {
                "--vertical-tabs-fade-top": `${fade.top}px`,
                "--vertical-tabs-fade-bottom": `${fade.bottom}px`,
              }
            : undefined
        }
        onScroll={() => {
          if (vertical()) measureFade()
        }}
      >
        <DragDropProvider
          sensors={[
            PointerSensor.configure({
              activationConstraints: (event) =>
                event.pointerType === "touch"
                  ? [new PointerActivationConstraints.Distance({ value: 8 })]
                  : [new PointerActivationConstraints.Distance({ value: 4 })],
              preventActivation: (event) =>
                event.target instanceof Element &&
                !!event.target.closest(
                  '[data-slot="tab-close"], [contenteditable="true"], [contenteditable="plaintext-only"]',
                ),
            }),
          ]}
          modifiers={[
            vertical() ? RestrictToVerticalAxis : RestrictToHorizontalAxis,
            RestrictToElement.configure({ element: () => listRef }),
          ]}
          plugins={(defaults) => [
            ...defaults.filter((plugin) => plugin !== Accessibility),
            AutoScroller.configure({
              acceleration: 8,
              threshold: vertical() ? { x: 0, y: 0.05 } : { x: 0.05, y: 0 },
            }),
            Feedback.configure({ dropAnimation: null }),
          ]}
          onDragStart={(event) => {
            const source = event.operation.source

            if (!source) return
            const tab = orderedTabs().find((item) => tabKey(item) === source.id.toString())

            if (!tab) return
            setDrag({ source: tabKey(tab), target: undefined, targetID: undefined, row: false })

            if (vertical()) {
              if (tab.type === "session")
                void global
                  .serverCtx(tab.server)
                  ?.data.session.sync(tab.sessionId, { children: true })
                  .catch(() => undefined)

              return
            }

            const tabEl = source.element?.querySelector<HTMLDivElement>("[data-titlebar-tab]")
            props.onNavigate(tab, tabEl ?? undefined)
          }}
          onDragOver={(event) => {
            if (!vertical()) return
            const target = event.operation.target
            const over = orderedTabs().find((item) => tabKey(item) === target?.id.toString())

            const destination: SessionDropDestination | undefined = target?.data.sessionFolder
              ? target.data.destination
              : over
                ? destinationFor(over)
                : undefined

            setDrag({
              target: destination,
              targetID: target?.data.sessionFolder ? target.id.toString() : undefined,
              row: !!over,
            })

            event.preventDefault()
          }}
          onDragEnd={(event) => {
            const current = visibleTabIds()
            const source = event.operation.source
            const target = event.operation.target
            const tab = orderedTabs().find((item) => tabKey(item) === source?.id.toString())
            const over = orderedTabs().find((item) => tabKey(item) === target?.id.toString())

            const destination: SessionDropDestination | undefined = target?.data.sessionFolder
              ? target.data.destination
              : over
                ? destinationFor(over)
                : drag.target

            setDrag({ source: undefined, target: undefined, targetID: undefined, row: false })

            if (event.canceled || !source || !tab || !target) return

            if (event.nativeEvent instanceof PointerEvent) {
              const element = target.data.sessionFolder
                ? target.element
                : vertical()
                  ? (target.element?.closest('[role="group"]') ?? listRef)
                  : listRef

              const rect = element?.getBoundingClientRect()
              const point = event.nativeEvent

              if (
                !rect ||
                point.clientX < rect.left ||
                point.clientX > rect.right ||
                point.clientY < rect.top ||
                point.clientY > rect.bottom
              )
                return
            }

            if (vertical() && destination) {
              if (!over || groupFor(tab) !== groupFor(over)) {
                void moveTo(tab, destination)

                return
              }

              if (!previewFor(tab, destination).allowed) return
            }

            if (!isSortable(source)) return

            const group = vertical()
              ? current.filter((key) => {
                  const item = orderedTabs().find((entry) => tabKey(entry) === key)

                  return item && groupFor(item) === groupFor(tab)
                })
              : current

            const initialIndex = vertical() ? group.indexOf(tabKey(tab)) : source.initialIndex
            const index = vertical() && over ? group.indexOf(tabKey(over)) : source.index

            if (initialIndex >= 0 && index >= 0 && initialIndex !== index) {
              const moved = arrayMove(group, initialIndex, index)
              const from = orderedTabs().find((tab) => tabKey(tab) === group[initialIndex])
              const to = orderedTabs().find((tab) => tabKey(tab) === group[index])

              if (!from || !to || pinned(from) !== pinned(to)) return

              if (
                vertical() &&
                (from.server !== to.server ||
                  projectFor(from) !== projectFor(to) ||
                  folderFor(from)?.id !== folderFor(to)?.id)
              )
                return

              if (pinned(from)) {
                const sessions = moved.flatMap((key) => pinnedTabs().find((tab) => tabKey(tab) === key) ?? [])

                for (const conn of global.servers.list()) {
                  const server = ServerConnection.key(conn)
                  pins.reorder(
                    server,
                    sessions.filter((tab) => tab.server === server).map((tab) => tab.sessionId),
                  )
                }

                return
              }

              props.onReorder(
                mergeVisibleTabOrder(
                  props.tabs.map(tabKey),
                  group.filter((key) => ordinaryTabs().some((tab) => tabKey(tab) === key)),
                  moved.filter((key) => ordinaryTabs().some((tab) => tabKey(tab) === key)),
                ),
              )
            }
          }}
        >
          <div
            data-titlebar-tab-list
            data-orientation={vertical() ? "vertical" : "horizontal"}
            class="flex w-full min-w-0"
            classList={{
              "flex-row items-center": !vertical(),
              "flex-col items-stretch": vertical(),
            }}
            ref={listRef}
          >
            <Show when={vertical()} fallback={<For each={ordinaryTabs()}>{renderTab}</For>}>
              <div role="group" aria-label={language.t("home.sessions.group.pinned")} class="flex flex-col gap-1">
                <button
                  type="button"
                  class="flex items-center gap-1.5 px-2 py-1 text-start text-[12px] leading-4 text-v2-text-text-faint"
                  aria-expanded={!sections.collapsed.pinned}
                  disabled={!sectionsReady()}
                  onClick={() => toggleSection("pinned")}
                >
                  <Icon name={sections.collapsed.pinned ? "chevron-right" : "chevron-down"} size="small" />
                  {language.t("home.sessions.group.pinned")}
                </button>
                <div class="flex flex-col gap-1" style={{ display: sections.collapsed.pinned ? "none" : undefined }}>
                  <For each={pinnedTabs()}>{renderTab}</For>
                </div>
              </div>
              <div role="group" aria-label={language.t("titlebar.tabs")} class="flex flex-col gap-1">
                <div class="px-2 py-1 text-[12px] leading-4 text-v2-text-text-faint">{language.t("titlebar.tabs")}</div>
                <For each={projects()}>
                  {(project) => (
                    <section aria-label={project.name} class="flex flex-col gap-1">
                      <SessionDropTarget
                        kind="project"
                        destination={{ server: project.server, project: project.directory }}
                        preview={dragPreview()}
                      >
                        <div class="flex items-center px-2 py-1 text-[12px] leading-4 text-v2-text-text-faint">
                          <button
                            type="button"
                            class="flex min-w-0 flex-1 items-center gap-1.5 text-start"
                            title={project.directory}
                            aria-expanded={
                              !sections.collapsed[sectionKey(project.server, project.directory, "project")]
                            }
                            disabled={!sectionsReady()}
                            onClick={() => toggleSection(sectionKey(project.server, project.directory, "project"))}
                          >
                            <Icon
                              name={
                                sections.collapsed[sectionKey(project.server, project.directory, "project")]
                                  ? "chevron-right"
                                  : "chevron-down"
                              }
                              size="small"
                            />
                            <span class="truncate">{project.name}</span>
                          </button>
                          <IconButton
                            size="small"
                            variant="ghost-muted"
                            aria-label={language.t("session.projects.removeIn", { project: project.name })}
                            title={language.t("session.projects.remove.description")}
                            icon={<Icon name="trash" />}
                            onClick={() => {
                              const ctx = global.serverCtx(project.server)

                              if (!ctx) return
                              ctx.projects.hide({ worktree: project.directory })
                              showToast({
                                title: language.t("session.projects.removed"),
                                description: language.t("session.projects.remove.description"),
                                actions: [
                                  {
                                    label: language.t("session.projects.undo"),
                                    onClick: () => ctx.projects.touch(project.directory),
                                  },
                                ],
                              })
                            }}
                          />
                          <IconButton
                            size="small"
                            variant="ghost-muted"
                            disabled={!folders.ready()}
                            aria-label={language.t("session.folders.createIn", {
                              project: project.name,
                            })}
                            icon={<Icon name="plus-small" />}
                            onClick={() =>
                              dialog.show(() => (
                                <FolderNameDialog server={project.server} project={project.directory} />
                              ))
                            }
                          />
                        </div>
                      </SessionDropTarget>
                      <div
                        class="flex flex-col gap-1 pl-4"
                        style={{
                          display: sections.collapsed[sectionKey(project.server, project.directory, "project")]
                            ? "none"
                            : undefined,
                        }}
                      >
                        <For
                          each={folders.list(project.server).filter((folder) => folder.project === project.directory)}
                        >
                          {(folder) => (
                            <SessionFolderGroup
                              server={project.server}
                              project={project.directory}
                              id={folder.id}
                              preview={dragPreview()}
                            >
                              <For each={project.tabs.filter((tab) => folderFor(tab)?.id === folder.id)}>
                                {renderTab}
                              </For>
                            </SessionFolderGroup>
                          )}
                        </For>
                        <SessionFolderGroup
                          server={project.server}
                          project={project.directory}
                          preview={dragPreview()}
                          collapsed={sections.collapsed[sectionKey(project.server, project.directory, "unfiled")]}
                          onToggle={() => toggleSection(sectionKey(project.server, project.directory, "unfiled"))}
                        >
                          <For each={project.tabs.filter((tab) => !folderFor(tab))}>{renderTab}</For>
                        </SessionFolderGroup>
                      </div>
                    </section>
                  )}
                </For>
                <For each={ordinaryTabs().filter((tab) => !projectFor(tab))}>{renderTab}</For>
              </div>
            </Show>
          </div>
        </DragDropProvider>
      </div>
      <Show when={vertical() && (dragPreview() || pendingMove())}>
        <div
          role="status"
          aria-live="polite"
          class="pointer-events-none absolute inset-x-2 bottom-2 z-30 rounded-md border border-v2-border-border-base bg-v2-background-bg-deep px-3 py-2 text-[12px] leading-4 shadow-lg"
        >
          <Show
            when={dragPreview()}
            fallback={language.t("session.move.moving", {
              destination: pendingMoveLabel(),
            })}
          >
            {(preview) => (
              <>
                <div class="font-medium" classList={{ "text-v2-state-fg-error": !preview().allowed }}>
                  {language.t(
                    preview().allowed
                      ? preview().unchanged
                        ? drag.row
                          ? "session.move.reorder"
                          : "session.move.unchanged"
                        : "session.move.preview"
                      : "session.move.blocked",
                    { destination: preview().label },
                  )}
                </div>
                <Show when={!preview().allowed}>
                  <div class="mt-1 text-v2-text-text-faint">{preview().message}</div>
                </Show>
                <Show when={preview().allowed && dragChangesContext()}>
                  <div class="mt-1 break-all text-v2-text-text-faint">
                    {language.t("session.move.context", { directory: drag.target?.project ?? "" })}
                  </div>
                </Show>
              </>
            )}
          </Show>
        </div>
      </Show>
      <Show when={!vertical()}>
        <div
          data-slot="titlebar-tabs-fade-left"
          aria-hidden="true"
          class="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-[linear-gradient(to_right,var(--v2-background-bg-deep),transparent)]"
        />
        <div
          data-slot="titlebar-tabs-fade-right"
          aria-hidden="true"
          class="pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-[linear-gradient(to_left,var(--v2-background-bg-deep),transparent)]"
        />
      </Show>
    </div>
  )
}
