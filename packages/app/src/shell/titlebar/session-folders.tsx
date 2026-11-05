import { Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode/ui/button"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Menu } from "@opencode/ui/menu"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { useLanguage } from "@/runtime/i18n/language"
import { ServerConnection } from "@/runtime/server/registry"
import { useTabs } from "@/shell/tabs/tabs"
import { SessionDropTarget, type SessionDropPreview } from "./session-drop-target"

export function FolderNameDialog(props: { server: ServerConnection.Key; project: string; id?: string }) {
  const language = useLanguage()
  const dialog = useDialog()
  const folders = useTabs().sessionFolders

  const [state, setState] = createStore({
    name: folders.get(props.server, props.id)?.name ?? "",
    invalid: false,
  })

  return (
    <Dialog fit containerClass="max-w-[calc(100vw-32px)]">
      <form
        class="flex w-full min-w-0 flex-col"
        onSubmit={(event) => {
          event.preventDefault()

          if (folders.save(props.server, props.project, state.name, props.id)) return dialog.close()
          setState("invalid", true)
        }}
      >
        <DialogHeader>
          <DialogTitleGroup title={language.t(props.id ? "session.folders.rename" : "session.folders.create")} />
        </DialogHeader>
        <div class="px-5 py-3">
          <label class="flex flex-col gap-2 text-[13px] leading-5">
            {language.t("session.folders.name")}
            <input
              autofocus
              value={state.name}
              onInput={(event) => setState({ name: event.currentTarget.value, invalid: false })}
              aria-invalid={state.invalid}
              class="w-full min-w-0 rounded-md border border-v2-border-border-base bg-transparent px-3 py-2 outline-none focus:border-v2-border-border-focus"
            />
          </label>
          <Show when={state.invalid}>
            <p role="alert" class="mt-2 text-[13px] leading-5">
              {language.t("session.folders.invalid")}
            </p>
          </Show>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button type="submit" variant="submit">
            {language.t("common.save")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  )
}

export function SessionFolderGroup(props: {
  server: ServerConnection.Key
  project: string
  id?: string
  collapsed?: boolean
  onToggle?: () => void
  preview?: SessionDropPreview
  children: JSX.Element
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const tabs = useTabs()
  const folders = tabs.sessionFolders
  const folder = () => folders.get(props.server, props.id)
  const collapsed = () => folder()?.collapsed ?? props.collapsed ?? false
  const name = () => folder()?.name ?? language.t("session.folders.none")

  return (
    <SessionDropTarget
      destination={{ server: props.server, project: props.project, folderID: props.id }}
      preview={props.preview}
    >
      <div role="group" aria-label={name()} class="flex flex-col gap-1">
        <div class="flex min-h-7 items-center rounded-md px-1 text-[12px] leading-4 text-v2-text-text-faint">
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-1.5 px-1 py-1 text-start"
            aria-expanded={!collapsed()}
            onClick={() => {
              if (props.id) return folders.collapse(props.server, props.id)
              props.onToggle?.()
            }}
          >
            <Icon name={collapsed() ? "chevron-right" : "chevron-down"} size="small" />
            <span class="truncate">{name()}</span>
          </button>
          <Show when={props.id}>
            <Menu>
              <Menu.Trigger
                as={IconButton}
                size="small"
                variant="ghost-muted"
                aria-label={language.t("session.folders.actions", {
                  name: name(),
                })}
                icon={<Icon name="outline-dots" />}
              />
              <Menu.Portal>
                <Menu.Content>
                  <Menu.Item
                    onSelect={() => {
                      if (!props.id) return

                      if (folder()?.collapsed) folders.collapse(props.server, props.id)
                      void tabs.newDraft({ server: props.server, directory: props.project, folderID: props.id })
                    }}
                  >
                    {language.t("session.folders.newSession")}
                  </Menu.Item>
                  <Menu.Item
                    onSelect={() =>
                      dialog.show(() => (
                        <FolderNameDialog server={props.server} project={props.project} id={props.id} />
                      ))
                    }
                  >
                    {language.t("common.rename")}
                  </Menu.Item>
                  <Menu.Separator />
                  <Menu.Item
                    data-variant="critical"
                    onSelect={() => {
                      if (props.id) folders.remove(props.server, props.id)
                    }}
                  >
                    {language.t("session.folders.delete")}
                  </Menu.Item>
                </Menu.Content>
              </Menu.Portal>
            </Menu>
          </Show>
        </div>
        <div class="flex flex-col gap-1 pl-2" style={{ display: collapsed() ? "none" : undefined }}>
          {props.children}
        </div>
      </div>
    </SessionDropTarget>
  )
}
