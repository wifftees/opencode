import { expect, test } from "bun:test"
import { mergeSessionFolders } from "./folders"

test("folder synchronization keeps independent edits, deletion tombstones, and deterministic membership moves", () => {
  const revision = { updated: 10, writer: "a" }

  const folder = {
    project: "/work",
    name: "Work",
    collapsed: false,
    deleted: false,
    ...revision,
  }

  const local = {
    folders: { local: { work: folder, other: { ...folder, name: "Other" } } },
    sessions: { local: { session: { folder: "work", ...revision } } },
  }

  const incoming = {
    folders: { local: { work: { ...folder, deleted: true, updated: 11 } } },
    sessions: { local: { session: { folder: "", ...revision, writer: "b" } } },
  }

  for (const [first, second] of [
    [local, incoming],
    [incoming, local],
  ]) {
    const merged = mergeSessionFolders(first!, second!)
    expect(merged.folders.local!.work!.deleted).toBe(true)
    expect(merged.folders.local!.other!.name).toBe("Other")
    expect(merged.sessions.local!.session!.folder).toBe("")
    expect(mergeSessionFolders(merged, local)).toEqual(merged)
  }
})
