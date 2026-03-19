export type FacebookTranscriptBlock = {
  timestamp: string | null
  actor: string | null
  text: string
  unresolved: boolean
}

const FACEBOOK_TIMESTAMP_PATTERN =
  /\b(?:[A-Z][a-z]{2,8} \d{1,2}, \d{4} \d{1,2}:\d{2}:\d{2} ?(?:am|pm)|\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC)\b/g

function compact(value: string | null | undefined) {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

function normalizeFacebookText(value: string | null | undefined) {
  if (!value) return ''

  const decoded = new DOMParser().parseFromString(value, 'text/html').documentElement.textContent ?? value
  return decoded
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function extractFacebookActor(segment: string) {
  const cleaned = segment.replace(/^[\s,:;'"`·-]+/, '')
  if (!cleaned) {
    return { actor: null, text: '' }
  }

  const colonIndex = cleaned.indexOf(':')
  if (colonIndex > 0 && colonIndex < 120) {
    const actor = cleaned.slice(0, colonIndex).trim()
    const body = compact(cleaned.slice(colonIndex + 1))
    if (actor && body) {
      return { actor, text: body }
    }
  }

  const actorMatch = cleaned.match(
    /^([A-Z][A-Za-z0-9'._-]+(?:\s+[A-Z][A-Za-z0-9'._-]+){0,3})\s+(.*)$/,
  )

  if (actorMatch) {
    const actor = compact(actorMatch[1])
    const body = compact(actorMatch[2])
    if (actor && body) {
      return { actor, text: body }
    }
  }

  return { actor: null, text: compact(cleaned) }
}

export function sanitizeFacebookTranscriptText(value: string | null | undefined) {
  return normalizeFacebookText(value)
}

export function splitFacebookTranscriptBlocks(value: string | null | undefined) {
  const plain = normalizeFacebookText(value)
  if (!plain) {
    return [{ timestamp: null, actor: null, text: '', unresolved: true }]
  }

  const matches = [...plain.matchAll(FACEBOOK_TIMESTAMP_PATTERN)]
  if (!matches.length) {
    const { actor, text } = extractFacebookActor(plain)
    return [{ timestamp: null, actor, text, unresolved: text.length === 0 }]
  }

  const blocks: FacebookTranscriptBlock[] = []

  matches.forEach((match, index) => {
    const timestamp = match[0]?.trim() ?? null
    const start = (match.index ?? 0) + (match[0]?.length ?? 0)
    const end = matches[index + 1]?.index ?? plain.length
    const segment = plain.slice(start, end).replace(/^[,:;\s"'`]+/, '').trim()

    if (!segment) {
      blocks.push({ timestamp, actor: null, text: '', unresolved: true })
      return
    }

    const { actor, text } = extractFacebookActor(segment)
    blocks.push({
      timestamp,
      actor,
      text,
      unresolved: text.length === 0,
    })
  })

  return blocks.length ? blocks : [{ timestamp: null, actor: null, text: plain, unresolved: false }]
}
