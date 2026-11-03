import { expect, test } from "bun:test"
import { mergeSessionPins } from "./pins"

test("pin merges preserve independent sessions and servers, keep unpin tombstones, and converge", () => {
  const pin = (updated: number, pinned = true, writer = "a") => ({ pinned, updated, writer })
  const first = { sessions: { local: { x: pin(1), z: pin(2, false), tie: pin(3, false, "b") } } }
  const second = { sessions: { remote: { x: pin(1) }, local: { y: pin(1), z: pin(1), tie: pin(3) } } }
  const merged = mergeSessionPins(first, second)
  expect(merged).toEqual({
    sessions: {
      local: { tie: pin(3, false, "b"), x: pin(1), y: pin(1), z: pin(2, false) },
      remote: { x: pin(1) },
    },
  })
  expect(JSON.stringify(mergeSessionPins(second, first))).toBe(JSON.stringify(merged))
  expect(mergeSessionPins(merged, first)).toEqual(merged)
})
