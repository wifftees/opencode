import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { showToast } from "@/shell/notifications/toast"
import type { SessionTab } from "./tabs"

export function createSessionTabClosing(input: {
  title: (tab: SessionTab) => string | undefined
  close: (tab: SessionTab) => boolean
  canRestore: (tab?: SessionTab) => boolean
  restore: (tab?: SessionTab) => void
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const [state, setState] = createStore({ undoable: false })

  const undo = (tab?: SessionTab) => {
    if (!input.canRestore(tab)) return
    input.restore(tab)
  }

  const keydown = (event: KeyboardEvent) => {
    if (
      !state.undoable ||
      dialog.active ||
      event.defaultPrevented ||
      event.isComposing ||
      event.altKey ||
      event.shiftKey ||
      event.repeat ||
      !(event.ctrlKey || event.metaKey) ||
      (event.code !== "KeyZ" && event.key.toLowerCase() !== "z") ||
      !input.canRestore()
    )
      return
    event.preventDefault()
    event.stopImmediatePropagation()
    undo()
  }

  const edited = () => setState("undoable", false)
  document.addEventListener("keydown", keydown, true)
  document.addEventListener("input", edited, true)
  onCleanup(() => {
    document.removeEventListener("keydown", keydown, true)
    document.removeEventListener("input", edited, true)
  })

  const confirm = (tab: SessionTab) => {
    const name = input.title(tab) || language.t("session.tab.session")

    dialog.show(() => (
      <Dialog fit>
        <DialogHeader hideClose>
          <DialogTitleGroup
            title={language.t("session.tab.close.title")}
            description={language.t("session.tab.close.confirm", { name })}
          />
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" autofocus onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            onClick={() => {
              if (!input.close(tab)) {
                dialog.close()

                return
              }

              setState("undoable", true)
              dialog.close()
              showToast({
                title: language.t("session.tab.close.closed", { name }),
                actions: [{ label: language.t("session.tab.close.undo"), onClick: () => undo(tab) }],
              })
            }}
          >
            {language.t("common.closeTab")}
          </Button>
        </DialogFooter>
      </Dialog>
    ))
  }

  return { confirm }
}
