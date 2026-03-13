import type {
  ContactSummary,
  DatasetStats,
  KeywordHit,
  NormalizedEvent,
  ParsedDataset,
  SignalFinding,
} from '../types'

const DEFAULT_PHRASES = [
  'delete this',
  'do not tell',
  "don't tell",
  'keep this between us',
  'miss you',
  'wish you were here',
  'come over',
  'thinking about you',
  'when can i see you',
]

const NIGHT_START_HOUR = 23
const NIGHT_END_HOUR = 5
const DAY_IN_MS = 24 * 60 * 60 * 1000

function isNightHour(date: Date) {
  const hour = date.getHours()
  return hour >= NIGHT_START_HOUR || hour <= NIGHT_END_HOUR
}

function formatExcerpt(text: string) {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact
}

function safeDate(value: string | null) {
  if (!value) {
    return null
  }

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function buildDataset(events: NormalizedEvent[]): ParsedDataset {
  const keywordHits = collectKeywordHits(events)
  const contacts = summarizeContacts(events, keywordHits)
  const signals = buildSignals(events, contacts, keywordHits)
  const stats = buildStats(events, contacts)

  return {
    events,
    fileSummaries: [],
    contacts,
    keywordHits,
    signals,
    stats,
  }
}

export function collectKeywordHits(events: NormalizedEvent[]): KeywordHit[] {
  return events
    .filter((event) => event.text)
    .flatMap((event) => {
      const text = event.text?.toLowerCase() ?? ''

      return DEFAULT_PHRASES.filter((phrase) => text.includes(phrase)).map((phrase) => ({
        phrase,
        contact: event.contact ?? 'Unknown contact',
        timestamp: event.timestamp,
        excerpt: formatExcerpt(event.text ?? ''),
      }))
    })
}

export function summarizeContacts(
  events: NormalizedEvent[],
  keywordHits: KeywordHit[],
): ContactSummary[] {
  const byContact = new Map<string, ContactSummary>()
  const keywordCounts = new Map<string, number>()

  keywordHits.forEach((hit) => {
    keywordCounts.set(hit.contact, (keywordCounts.get(hit.contact) ?? 0) + 1)
  })

  events
    .filter((event) => event.contact)
    .forEach((event) => {
      const name = event.contact ?? 'Unknown contact'
      const existing = byContact.get(name) ?? {
        name,
        interactions: 0,
        firstSeen: event.timestamp,
        lastSeen: event.timestamp,
        lateNightInteractions: 0,
        keywordHits: keywordCounts.get(name) ?? 0,
      }

      existing.interactions += 1

      const eventDate = safeDate(event.timestamp)
      const firstSeen = safeDate(existing.firstSeen)
      const lastSeen = safeDate(existing.lastSeen)

      if (eventDate && (!firstSeen || eventDate < firstSeen)) {
        existing.firstSeen = event.timestamp
      }

      if (eventDate && (!lastSeen || eventDate > lastSeen)) {
        existing.lastSeen = event.timestamp
      }

      if (eventDate && isNightHour(eventDate)) {
        existing.lateNightInteractions += 1
      }

      byContact.set(name, existing)
    })

  return [...byContact.values()].sort((left, right) => right.interactions - left.interactions)
}

export function buildSignals(
  events: NormalizedEvent[],
  contacts: ContactSummary[],
  keywordHits: KeywordHit[],
): SignalFinding[] {
  const findings: SignalFinding[] = []
  const now = Date.now()
  const recentWindowStart = now - 30 * DAY_IN_MS
  const previousWindowStart = now - 60 * DAY_IN_MS

  contacts.slice(0, 8).forEach((contact) => {
    const contactEvents = events.filter((event) => event.contact === contact.name)
    const recentCount = contactEvents.filter((event) => {
      const eventDate = safeDate(event.timestamp)
      return eventDate ? eventDate.getTime() >= recentWindowStart : false
    }).length
    const previousCount = contactEvents.filter((event) => {
      const eventDate = safeDate(event.timestamp)
      return eventDate
        ? eventDate.getTime() >= previousWindowStart &&
            eventDate.getTime() < recentWindowStart
        : false
    }).length

    if (recentCount >= 6 && recentCount >= previousCount * 2.5) {
      findings.push({
        title: `${contact.name}: acceleration`,
        severity: 'high',
        summary:
          'Interaction volume increased sharply in the last 30 days compared with the prior 30-day window.',
      })
    }

    if (contact.lateNightInteractions >= 4) {
      findings.push({
        title: `${contact.name}: late-night pattern`,
        severity: 'medium',
        summary:
          'Repeated activity appears during overnight hours, which can be useful to review in context.',
      })
    }

    if (contact.keywordHits >= 2) {
      findings.push({
        title: `${contact.name}: keyword review`,
        severity: 'medium',
        summary:
          'Multiple saved chat lines matched sensitive phrase patterns and should be reviewed manually.',
      })
    }
  })

  const locationDays = new Set(
    events
      .filter((event) => event.category === 'location')
      .map((event) => safeDate(event.timestamp)?.toISOString().slice(0, 10))
      .filter(Boolean),
  )
  const communicationDays = new Set(
    events
      .filter((event) => event.category === 'chat' || event.category === 'search')
      .map((event) => safeDate(event.timestamp)?.toISOString().slice(0, 10))
      .filter(Boolean),
  )
  const overlapDays = [...locationDays].filter((day) => communicationDays.has(day)).length

  if (overlapDays >= 3) {
    findings.push({
      title: 'Location and communication overlap',
      severity: 'medium',
      summary:
        'Several days contain both location records and elevated communication activity, which may be worth correlating.',
    })
  }

  const uniqueDevices = new Set(
    events.filter((event) => event.device).map((event) => event.device),
  ).size

  if (uniqueDevices >= 2) {
    findings.push({
      title: 'Multiple devices detected',
      severity: 'low',
      summary:
        'The export references more than one device. This is often benign but useful to keep in the audit view.',
    })
  }

  if (keywordHits.length === 0 && findings.length === 0) {
    findings.push({
      title: 'No strong patterns yet',
      severity: 'low',
      summary:
        'The current export did not surface notable heuristics. This does not prove anything one way or the other.',
    })
  }

  return findings
}

export function buildStats(
  events: NormalizedEvent[],
  contacts: ContactSummary[],
): DatasetStats {
  return {
    totalEvents: events.length,
    chatEvents: events.filter((event) => event.category === 'chat').length,
    locationEvents: events.filter((event) => event.category === 'location').length,
    loginEvents: events.filter((event) => event.category === 'login').length,
    searchEvents: events.filter((event) => event.category === 'search').length,
    memoryEvents: events.filter((event) => event.category === 'memory').length,
    uniqueContacts: contacts.length,
  }
}
