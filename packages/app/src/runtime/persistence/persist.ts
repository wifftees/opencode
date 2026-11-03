import type { AsyncStorage, PersistenceSyncAPI, SyncStorage } from "@solid-primitives/storage"
import { getOwner, onCleanup, untrack } from "solid-js"
import { reconcile, type SetStoreFunction, type Store } from "solid-js/store"

const persistSaveDelay = 100

const pending = new Set<() => void>()

/** Serialize and write every store with unsaved changes now. */
export function flushPersisted() {
  for (const save of [...pending]) save()
}

// Covers synchronous web storage. Desktop registers its own pagehide handling earlier than this
// module loads, so its shutdown path calls flushPersisted() itself before flushing namespaces.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPersisted()
  })
  window.addEventListener("pagehide", flushPersisted)
}

// A store whose serialized form is written to storage on a schedule instead of on every setter
// call. The setter only marks the store dirty; serialization happens once per save window, once
// per owner cleanup, and when the page hides. Mirrors VS Code's Memento.
export function persistStore<T extends object>(input: {
  store: Store<T>
  setStore: SetStoreFunction<T>
  name: string
  storage: SyncStorage | AsyncStorage
  serialize: (value: T) => string
  deserialize: (raw: string) => T
  sync?: PersistenceSyncAPI
  merge?: (local: T, incoming: T) => T
  delay?: number
  /** Replaces `storage.setItem` for stores whose storage can take the value itself. */
  write?: (value: T, serialized: string) => void
}) {
  const delay = input.delay ?? persistSaveDelay
  let dirty = false
  let touched = false
  let last: string | undefined
  // The newest value another window wrote while this store was dirty; applied at save time if the
  // local setter calls turned out not to change anything.
  let remote: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const save = () => {
    clearTimeout(timer)
    timer = undefined
    pending.delete(save)

    if (!dirty) return
    dirty = false
    const held = remote
    remote = undefined
    const next = untrack(() => input.serialize(input.store))

    if (next === last) {
      if (held !== undefined && held !== last) hydrate(held)

      return
    }

    last = next
    input.sync?.[1](input.name, next)

    if (input.write) return input.write(input.store, next)
    void input.storage.setItem(input.name, next)
  }

  const setStore: SetStoreFunction<T> = (...values: unknown[]) => {
    // SAFETY: this typed wrapper only forwards Solid setter arguments; the tuple exposes its final overload to TypeScript.
    input.setStore(...(values as Parameters<SetStoreFunction<T>>))
    dirty = true
    touched = true
    pending.add(save)
    timer ??= setTimeout(save, delay)
  }

  const hydrate = (raw: string) => {
    last = raw
    input.setStore(reconcile(input.deserialize(raw)))
  }

  const merge = (raw: string) => {
    if (!input.merge) return hydrate(raw)
    const merged = input.merge(input.store, input.deserialize(raw))

    last = raw
    remote = undefined

    if (input.serialize(merged) === raw) {
      clearTimeout(timer)
      timer = undefined
      pending.delete(save)
      dirty = false
      input.setStore(reconcile(merged))

      return
    }

    setStore(reconcile(merged))
  }

  const init = input.storage.getItem(input.name)

  // A value the user already changed is newer than whatever storage held.
  if (init instanceof Promise) void init.then((raw) => raw && (!touched || input.merge) && merge(raw))
  else if (init) merge(init)

  input.sync?.[0]((data) => {
    if (data.key !== input.name || (!input.merge && (data.url ?? location.href) !== location.href)) return

    if (!data.newValue) return

    if (input.merge) return merge(data.newValue)

    // A real unsaved local change wins over another window's write, as in VS Code's storage
    // service; whether the change is real is only known when the store is serialized. Every
    // remote value replaces the held one, including a revert to `last`, so the save sees the
    // other window's final state rather than an intermediate one.
    if (dirty) {
      remote = data.newValue

      return
    }

    if (data.newValue === last) return
    hydrate(data.newValue)
  })

  if (getOwner()) onCleanup(save)

  return { setStore, init, flush: save }
}
