const fold = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()

export function sessionSnippetParts(text: string, query: string) {
  const terms = (query.match(/[\p{L}\p{N}_]+/gu) ?? []).map(fold)
  const parts: { text: string; matched: boolean }[] = []
  let offset = 0

  for (const word of text.matchAll(/[\p{L}\p{N}_]+/gu)) {
    if (word.index > offset) parts.push({ text: text.slice(offset, word.index), matched: false })
    parts.push({ text: word[0], matched: terms.some((term) => fold(word[0]).startsWith(term)) })
    offset = word.index + word[0].length
  }

  if (offset < text.length) parts.push({ text: text.slice(offset), matched: false })

  return parts
}
