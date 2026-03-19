import type {
  ContactSummary,
  DataCategory,
  DatasetStats,
  EntitySummary,
  EvidenceSnippet,
  HeatmapCell,
  HourBucket,
  KeywordHit,
  NormalizedEvent,
  NotablePeriod,
  ParsedUpload,
  PhrasePattern,
  SignalFinding,
  TimelineBucket,
  ToneSummary,
  WeekdayBucket,
  WorkspaceDataset,
} from '../types'

const DAY_IN_MS = 24 * 60 * 60 * 1000
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const CONTACT_CATEGORIES = new Set<DataCategory>([
  'chat',
  'event',
  'friend',
  'group',
  'page',
  'post',
  'reaction',
  'search',
  'unknown',
])
const USERNAME_HINT = /[@._\d]/
const NAME_STOPWORDS = new Set([
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
  'Delete This',
  'Keep This',
  'Snap Chat',
])
const PHRASE_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'you',
  'with',
  'that',
  'this',
  'from',
  'have',
  'your',
  'just',
  'been',
  'were',
  'about',
  'they',
  'what',
  'when',
  'there',
  'then',
  'them',
  'dont',
  'will',
])
const DELETION_KEYWORDS = [
  'delete',
  'deleted',
  'remove',
  'removed',
  'unsave',
  'unsaved',
  'clear chat',
  'cleared',
  'blocked',
  'unfriend',
  'unfriended',
  'unadd',
  'unadded',
  'removed friend',
  'deleted friend',
]

const TONE_RULES = [
  {
    category: 'affection',
    label: 'Affection indicators',
    phrases: [
      'miss you',
      'thinking about you',
      'wish you were here',
      'love you',
      'miss you already',
    ],
  },
  {
    category: 'flirt',
    label: 'Flirt indicators',
    phrases: [
      'babe',
      'baby',
      'cute',
      'handsome',
      'pretty',
      'thinking of you',
      'wish you were here',
      'cant wait to see you',
      "can't wait to see you",
      'come over',
    ],
  },
  {
    category: 'secrecy',
    label: 'Secrecy indicators',
    phrases: [
      'delete this',
      "don't tell",
      'keep this between us',
      'do not tell',
      'clear this chat',
    ],
  },
  {
    category: 'planning',
    label: 'Private planning indicators',
    phrases: [
      'come over',
      'when can i see you',
      'meet me',
      'are you free',
      'send me the address',
    ],
  },
  {
    category: 'romantic',
    label: 'Romantic tone indicators',
    phrases: [
      'beautiful',
      'cute',
      'want you',
      'thinking of you',
      'wish you were here',
    ],
  },
]

type ActivityBuckets = {
  hourBuckets: HourBucket[]
  weekdayBuckets: WeekdayBucket[]
  heatmap: HeatmapCell[]
}

type InternalContact = {
  name: string
  interactions: number
  messageCount: number
  selfMessageCount: number
  contactMessageCount: number
  selfMediaCount: number
  contactMediaCount: number
  searchCount: number
  friendEventCount: number
  lateNightInteractions: number
  uploads: Set<string>
  activeDays: Set<string>
  firstSeen: string | null
  lastSeen: string | null
  firstSourceFile: string | null
  lastSourceFile: string | null
  recentCount: number
  previousCount: number
  deletionIndicators: number
  categoryCounts: Partial<Record<DataCategory, number>>
  evidenceIds: string[]
  hourCounts: number[]
  weekdayCounts: number[]
  phraseCounts: Map<string, number>
}

function safeDate(value: string | null) {
  if (!value) {
    return null
  }

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function formatDayLabel(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
}

function normalizeText(value: string | null) {
  return value?.toLowerCase().trim() ?? ''
}

function compact(text: string) {
  return text.replace(/\s+/g, ' ').trim()
}

function normalizeAlias(value: string) {
  return value.toLowerCase().trim()
}

function extractActorValue(event: NormalizedEvent) {
  const keys = ['sender', 'sender_name', 'from', 'author', 'participant', 'display_name', 'user', 'username']
  for (const key of keys) {
    const value = event.attributes[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return null
}

function buildSelfAliasLookup(uploads: ParsedUpload[]) {
  return new Map(
    uploads.map((upload) => {
      const values = [
        upload.upload.account.username,
        upload.upload.account.displayName,
        upload.upload.account.email,
        upload.upload.account.phone,
        ...upload.upload.account.aliases,
      ]
        .filter((value): value is string => Boolean(value))
        .map((value) => normalizeAlias(value))

      return [upload.upload.id, new Set(values)] as const
    }),
  )
}

function resolveEventRole(event: NormalizedEvent, selfAliases: Map<string, Set<string>>) {
  if (event.category !== 'chat') {
    return 'other' as const
  }

  const actor = extractActorValue(event)
  if (!actor) {
    return 'other' as const
  }

  const aliases = selfAliases.get(event.uploadId)
  return aliases?.has(normalizeAlias(actor)) ? ('self' as const) : ('contact' as const)
}

function isMediaTranscriptEvent(event: NormalizedEvent) {
  const marker = typeof event.attributes.marker === 'string' ? event.attributes.marker.toUpperCase() : ''
  const subtype = typeof event.subtype === 'string' ? event.subtype.toLowerCase() : ''
  return marker === 'MEDIA' || subtype.includes('photo') || subtype.includes('video') || subtype.includes('image')
}

function clampScore(value: number) {
  return Math.max(1, Math.min(10, Math.round(value)))
}

function buildExcerpt(text: string | null) {
  const input = compact(text ?? '')
  if (!input) {
    return 'No text excerpt available.'
  }

  return input.length > 160 ? `${input.slice(0, 157)}...` : input
}

function recentWindowBounds(events: NormalizedEvent[]) {
  const latest = [...events]
    .map((event) => safeDate(event.timestamp)?.getTime() ?? 0)
    .sort((left, right) => right - left)[0]

  const anchor = latest || Date.now()
  return {
    anchor,
    recentStart: anchor - 14 * DAY_IN_MS,
    previousStart: anchor - 28 * DAY_IN_MS,
  }
}

function extractMatches(text: string) {
  return {
    emails: [...text.matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)].map(
      (match) => match[0],
    ),
    phones: [...text.matchAll(/(?:\+?\d[\d(). -]{7,}\d)/g)].map((match) => match[0]),
    links: [...text.matchAll(/https?:\/\/[^\s]+/gi)].map((match) => match[0]),
    handles: [...text.matchAll(/@[a-z0-9._]{2,}/gi)].map((match) => match[0]),
  }
}

function extractNameMatches(text: string) {
  return [...text.matchAll(/\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){1,2})\b/g)]
    .map((match) => match[1].trim())
    .filter((value) => !NAME_STOPWORDS.has(value))
}

function looksLikeUsername(value: string) {
  return USERNAME_HINT.test(value) || !value.includes(' ')
}

function extractPhrases(text: string | null) {
  const normalized = normalizeText(text)
  if (!normalized) {
    return []
  }

  const words = normalized
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !PHRASE_STOPWORDS.has(word))

  const phrases: string[] = []
  for (let index = 0; index < words.length - 1; index += 1) {
    const phrase = `${words[index]} ${words[index + 1]}`
    if (phrase.length >= 6) {
      phrases.push(phrase)
    }
  }
  return phrases
}

function pushEntity(
  index: Map<string, EntitySummary>,
  type: EntitySummary['type'],
  value: string,
  event: NormalizedEvent,
) {
  const trimmed = value.trim()
  if (!trimmed) {
    return
  }

  const key = `${type}:${trimmed.toLowerCase()}`
  const current = index.get(key) ?? {
    id: key,
    type,
    value: trimmed,
    count: 0,
    contacts: [],
    uploads: [],
    evidenceIds: [],
  }

  current.count += 1
  if (event.contact && !current.contacts.includes(event.contact)) {
    current.contacts.push(event.contact)
  }
  if (!current.uploads.includes(event.uploadId)) {
    current.uploads.push(event.uploadId)
  }
  if (!current.evidenceIds.includes(event.id)) {
    current.evidenceIds.push(event.id)
  }

  index.set(key, current)
}

function matchesDeletionIndicator(event: NormalizedEvent) {
  const haystack = normalizeText(
    [event.text, event.detail, event.subtype, event.evidenceText, event.sourceFile].filter(Boolean).join(' '),
  )

  return DELETION_KEYWORDS.some((keyword) => haystack.includes(keyword))
}

function collectKeywordHits(events: NormalizedEvent[]) {
  const hits: KeywordHit[] = []

  events.forEach((event) => {
    const text = normalizeText(event.text)
    if (!text) {
      return
    }

    TONE_RULES.forEach((rule) => {
      rule.phrases.forEach((phrase) => {
        if (text.includes(phrase)) {
          hits.push({
            phrase,
            category: rule.category,
            contact: event.contact ?? 'Unknown contact',
            timestamp: event.timestamp,
            excerpt: buildExcerpt(event.text),
            eventId: event.id,
          })
        }
      })
    })
  })

  return hits
}

function buildToneSummaries(keywordHits: KeywordHit[]) {
  const byTone = new Map<string, ToneSummary>()

  keywordHits.forEach((hit) => {
    const rule = TONE_RULES.find((candidate) => candidate.category === hit.category)
    const current = byTone.get(hit.category) ?? {
      category: hit.category,
      label: rule?.label ?? hit.category,
      count: 0,
      contacts: [],
      evidenceIds: [],
    }

    current.count += 1
    if (!current.contacts.includes(hit.contact)) {
      current.contacts.push(hit.contact)
    }
    if (!current.evidenceIds.includes(hit.eventId)) {
      current.evidenceIds.push(hit.eventId)
    }

    byTone.set(hit.category, current)
  })

  return [...byTone.values()].sort((left, right) => right.count - left.count)
}

function buildRepeatedPhrases(events: NormalizedEvent[]) {
  const counts = new Map<string, PhrasePattern>()

  events.forEach((event) => {
    extractPhrases(event.text).forEach((phrase) => {
      const current = counts.get(phrase) ?? {
        phrase,
        count: 0,
        contacts: [],
        evidenceIds: [],
      }

      current.count += 1
      if (event.contact && !current.contacts.includes(event.contact)) {
        current.contacts.push(event.contact)
      }
      if (!current.evidenceIds.includes(event.id)) {
        current.evidenceIds.push(event.id)
      }

      counts.set(phrase, current)
    })
  })

  return [...counts.values()]
    .filter((phrase) => phrase.count > 1)
    .sort((left, right) => right.count - left.count)
    .slice(0, 18)
}

function buildActivityBuckets(events: NormalizedEvent[]): ActivityBuckets {
  const hourCounts = Array.from({ length: 24 }, () => 0)
  const weekdayCounts = Array.from({ length: 7 }, () => 0)
  const heatmapCounts = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0))

  events.forEach((event) => {
    const date = safeDate(event.timestamp)
    if (!date) {
      return
    }

    const day = date.getDay()
    const hour = date.getHours()
    hourCounts[hour] += 1
    weekdayCounts[day] += 1
    heatmapCounts[day][hour] += 1
  })

  return {
    hourBuckets: hourCounts.map((count, hour) => ({ hour, count })),
    weekdayBuckets: weekdayCounts.map((count, day) => ({
      day,
      label: WEEKDAY_LABELS[day],
      count,
    })),
    heatmap: heatmapCounts.flatMap((hours, day) =>
      hours.map((count, hour) => ({
        day,
        hour,
        count,
      })),
    ),
  }
}

function topHourFromCounts(counts: number[]) {
  let topHour: number | null = null
  let topCount = 0

  counts.forEach((count, hour) => {
    if (count > topCount) {
      topCount = count
      topHour = hour
    }
  })

  return topCount > 0 ? topHour : null
}

function topWeekdayFromCounts(counts: number[]) {
  let topDay: number | null = null
  let topCount = 0

  counts.forEach((count, day) => {
    if (count > topCount) {
      topCount = count
      topDay = day
    }
  })

  return topCount > 0 && topDay !== null ? WEEKDAY_LABELS[topDay] : null
}

function buildContacts(
  events: NormalizedEvent[],
  keywordHits: KeywordHit[],
  selfAliasesByUpload: Map<string, Set<string>>,
) {
  const hitsByContact = new Map<string, KeywordHit[]>()
  keywordHits.forEach((hit) => {
    const existing = hitsByContact.get(hit.contact) ?? []
    existing.push(hit)
    hitsByContact.set(hit.contact, existing)
  })

  const { recentStart, previousStart } = recentWindowBounds(events)
  const index = new Map<string, InternalContact>()

  events.forEach((event) => {
    if (!event.contact || !CONTACT_CATEGORIES.has(event.category)) {
      return
    }

    const current = index.get(event.contact) ?? {
      name: event.contact,
      interactions: 0,
      messageCount: 0,
      selfMessageCount: 0,
      contactMessageCount: 0,
      selfMediaCount: 0,
      contactMediaCount: 0,
      searchCount: 0,
      friendEventCount: 0,
      lateNightInteractions: 0,
      uploads: new Set<string>(),
      activeDays: new Set<string>(),
      firstSeen: null,
      lastSeen: null,
      firstSourceFile: null,
      lastSourceFile: null,
      recentCount: 0,
      previousCount: 0,
      deletionIndicators: 0,
      categoryCounts: {},
      evidenceIds: [],
      hourCounts: Array.from({ length: 24 }, () => 0),
      weekdayCounts: Array.from({ length: 7 }, () => 0),
      phraseCounts: new Map<string, number>(),
    }

    current.interactions += 1
    current.uploads.add(event.uploadId)
    current.categoryCounts[event.category] = (current.categoryCounts[event.category] ?? 0) + 1

    if (event.category === 'chat') {
      current.messageCount += 1
      const role = resolveEventRole(event, selfAliasesByUpload)
      if (role === 'self') {
        current.selfMessageCount += 1
      } else {
        current.contactMessageCount += 1
      }

      if (isMediaTranscriptEvent(event)) {
        if (role === 'self') {
          current.selfMediaCount += 1
        } else {
          current.contactMediaCount += 1
        }
      }
    }
    if (event.category === 'search') {
      current.searchCount += 1
    }
    if (event.category === 'friend') {
      current.friendEventCount += 1
    }
    if (matchesDeletionIndicator(event)) {
      current.deletionIndicators += 1
    }
    if (!current.evidenceIds.includes(event.id)) {
      current.evidenceIds.push(event.id)
    }

    extractPhrases(event.text).forEach((phrase) => {
      current.phraseCounts.set(phrase, (current.phraseCounts.get(phrase) ?? 0) + 1)
    })

    const date = safeDate(event.timestamp)
    if (!date) {
      index.set(event.contact, current)
      return
    }

    const dayKey = date.toISOString().slice(0, 10)
    current.activeDays.add(dayKey)
    current.hourCounts[date.getHours()] += 1
    current.weekdayCounts[date.getDay()] += 1

    const time = date.getTime()
    if (time >= recentStart) {
      current.recentCount += 1
    } else if (time >= previousStart) {
      current.previousCount += 1
    }

    const hour = date.getHours()
    if (hour >= 23 || hour <= 5) {
      current.lateNightInteractions += 1
    }
    if (!current.firstSeen || date < new Date(current.firstSeen)) {
      current.firstSeen = event.timestamp
    }
    if (!current.lastSeen || date > new Date(current.lastSeen)) {
      current.lastSeen = event.timestamp
    }
    if (!current.firstSourceFile) {
      current.firstSourceFile = event.sourceFile
    }
    current.lastSourceFile = event.sourceFile

    index.set(event.contact, current)
  })

  return [...index.values()]
    .map((contact): ContactSummary => {
      const hits = hitsByContact.get(contact.name) ?? []
      const flirtHits = hits.filter((hit) => ['affection', 'planning', 'flirt', 'romantic'].includes(hit.category)).length
      const secrecyHits = hits.filter((hit) => hit.category === 'secrecy').length
      const intensityBase =
        contact.messageCount / 4 +
        contact.activeDays.size / 3 +
        Math.max(contact.recentCount - contact.previousCount, 0) / 3 +
        contact.lateNightInteractions / 4

      return {
        name: contact.name,
        interactions: contact.interactions,
        messageCount: contact.messageCount,
        selfMessageCount: contact.selfMessageCount,
        contactMessageCount: contact.contactMessageCount,
        selfMediaCount: contact.selfMediaCount,
        contactMediaCount: contact.contactMediaCount,
        searchCount: contact.searchCount,
        friendEventCount: contact.friendEventCount,
        lateNightInteractions: contact.lateNightInteractions,
        keywordHits: hits.length,
        uploads: contact.uploads.size,
        activeDays: contact.activeDays.size,
        firstSeen: contact.firstSeen,
        lastSeen: contact.lastSeen,
        firstSourceFile: contact.firstSourceFile,
        lastSourceFile: contact.lastSourceFile,
        recentChange: contact.recentCount - contact.previousCount,
        deletionIndicators: contact.deletionIndicators,
        romanticScore: clampScore(1 + flirtHits * 1.8 + contact.lateNightInteractions * 0.3),
        secrecyScore: clampScore(1 + secrecyHits * 2.6 + contact.deletionIndicators * 1.8 + Math.max(contact.recentCount - contact.previousCount, 0) * 0.35),
        intensityScore: clampScore(1 + intensityBase),
        missingChat:
          contact.messageCount === 0 && (contact.searchCount > 0 || contact.friendEventCount > 0),
        peakHour: topHourFromCounts(contact.hourCounts),
        peakWeekday: topWeekdayFromCounts(contact.weekdayCounts),
        categoryCounts: contact.categoryCounts,
        topPhrases: [...contact.phraseCounts.entries()]
          .filter(([, count]) => count > 1)
          .sort((left, right) => right[1] - left[1])
          .slice(0, 3)
          .map(([phrase]) => phrase),
        topToneLabels: TONE_RULES.filter((rule) =>
          hits.some((hit) => hit.category === rule.category),
        ).map((rule) => rule.label),
        evidenceIds: contact.evidenceIds,
      }
    })
    .sort((left, right) => {
      if (right.interactions !== left.interactions) {
        return right.interactions - left.interactions
      }
      return right.messageCount - left.messageCount
    })
}

function buildEntities(events: NormalizedEvent[]) {
  const entityIndex = new Map<string, EntitySummary>()

  events.forEach((event) => {
    const eventText = compact(
      [event.contact, event.text, event.detail, event.locationName, event.region]
        .filter(Boolean)
        .join(' '),
    )

    if (event.contact && event.category !== 'account') {
      pushEntity(entityIndex, 'person', event.contact, event)
      if (looksLikeUsername(event.contact)) {
        pushEntity(entityIndex, 'username', event.contact, event)
      }
    }
    if (event.locationName) {
      pushEntity(entityIndex, 'location', event.locationName, event)
    }

    extractNameMatches(event.text ?? '').forEach((value) => pushEntity(entityIndex, 'name', value, event))

    const matches = extractMatches(eventText)
    matches.emails.forEach((value) => pushEntity(entityIndex, 'email', value, event))
    matches.phones.forEach((value) => pushEntity(entityIndex, 'phone', value, event))
    matches.links.forEach((value) => pushEntity(entityIndex, 'link', value, event))
    matches.handles.forEach((value) => pushEntity(entityIndex, 'handle', value, event))
  })

  return [...entityIndex.values()]
    .filter((entity) => entity.count > 0)
    .sort((left, right) => right.count - left.count)
}

function buildTimeline(events: NormalizedEvent[]) {
  const timeline = new Map<string, TimelineBucket>()

  events.forEach((event) => {
    if (!event.timestamp) {
      return
    }

    const key = event.timestamp.slice(0, 10)
    const current = timeline.get(key) ?? {
      key,
      label: formatDayLabel(key),
      count: 0,
      categories: {},
      evidenceIds: [],
    }

    current.count += 1
    current.categories[event.category] = (current.categories[event.category] ?? 0) + 1
    if (!current.evidenceIds.includes(event.id)) {
      current.evidenceIds.push(event.id)
    }

    timeline.set(key, current)
  })

  return [...timeline.values()].sort((left, right) => left.key.localeCompare(right.key))
}

function buildEvidenceSnippets(events: NormalizedEvent[], evidenceIds: string[]) {
  const eventIndex = new Map(events.map((event) => [event.id, event]))

  return evidenceIds
    .map((eventId) => eventIndex.get(eventId))
    .filter((event): event is NormalizedEvent => Boolean(event))
    .slice(0, 18)
    .map((event): EvidenceSnippet => ({
      eventId: event.id,
      uploadId: event.uploadId,
      label: event.contact ?? event.category,
      timestamp: event.timestamp,
      sourceFile: event.sourceFile,
      excerpt: buildExcerpt(event.evidenceText || event.text || event.detail),
    }))
}

function buildSignals(
  events: NormalizedEvent[],
  contacts: ContactSummary[],
  entities: EntitySummary[],
  keywordHits: KeywordHit[],
  timeline: TimelineBucket[],
) {
  const findings: SignalFinding[] = []

  contacts.slice(0, 12).forEach((contact) => {
    if (contact.recentChange >= 4) {
      findings.push({
        id: `contact-change-${contact.name}`,
        title: `${contact.name}: activity shift`,
        type: 'intensity-shift',
        severity: 'high',
        score: 84,
        summary: 'Communication volume increased noticeably in the most recent comparison window.',
        explanation:
          'Recent interaction count is materially above the prior equal-length window, which makes this contact worth reviewing in context.',
        evidenceIds: contact.evidenceIds.slice(0, 5),
      })
    }

    if (contact.lateNightInteractions >= 4) {
      findings.push({
        id: `contact-night-${contact.name}`,
        title: `${contact.name}: late-night concentration`,
        type: 'time-pattern',
        severity: 'medium',
        score: 68,
        summary: 'A meaningful share of activity with this contact happened overnight.',
        explanation:
          'The concentration of events between 11 PM and 5 AM is higher than typical and may matter in a timeline review.',
        evidenceIds: contact.evidenceIds.slice(0, 5),
      })
    }

    if (contact.romanticScore >= 8 && contact.messageCount >= 3) {
      findings.push({
        id: `contact-romantic-${contact.name}`,
        title: `${contact.name}: elevated relational tone`,
        type: 'tone-pattern',
        severity: 'medium',
        score: 73,
        summary: 'This thread contains multiple relational or romantic-tone indicators.',
        explanation:
          'The score is based on deterministic phrase matches, activity density, and time-of-day concentration. It is not a claim about intent.',
        evidenceIds: contact.evidenceIds.slice(0, 5),
      })
    }

    if (contact.secrecyScore >= 7) {
      findings.push({
        id: `contact-secrecy-${contact.name}`,
        title: `${contact.name}: secrecy or cleanup indicators`,
        type: 'secrecy-pattern',
        severity: 'medium',
        score: 78,
        summary: 'This contact has repeated secrecy-oriented language or deletion/removal signals.',
        explanation:
          'The score comes from deterministic phrase rules and deletion/removal keyword matches in linked rows.',
        evidenceIds: contact.evidenceIds.slice(0, 5),
      })
    }
  })

  const topDay = [...timeline].sort((left, right) => right.count - left.count)[0]
  const typicalDaily = timeline.length
    ? timeline.reduce((sum, item) => sum + item.count, 0) / timeline.length
    : 0

  if (topDay && topDay.count >= typicalDaily * 2.2 && topDay.count >= 6) {
    findings.push({
      id: `timeline-spike-${topDay.key}`,
      title: `${topDay.label}: notable spike`,
      type: 'volume-spike',
      severity: 'medium',
      score: 72,
      summary: 'This day shows a volume spike relative to the surrounding activity baseline.',
      explanation:
        'The daily event total materially exceeded the average daily count across the loaded data.',
      evidenceIds: topDay.evidenceIds.slice(0, 5),
    })
  }

  const deletionEvents = events.filter(matchesDeletionIndicator)
  if (deletionEvents.length > 0) {
    findings.push({
      id: 'deletion-indicators',
      title: 'Deletion or removal indicators present',
      type: 'deletion-indicator',
      severity: deletionEvents.length >= 4 ? 'high' : 'medium',
      score: deletionEvents.length >= 4 ? 82 : 64,
      summary: 'Some rows contain delete/remove/blocked-style language or action terms.',
      explanation:
        'These may be message content, action metadata, or row labels. Review the cited rows directly before drawing conclusions.',
      evidenceIds: deletionEvents.map((event) => event.id).slice(0, 8),
    })
  }

  const missingChatContacts = contacts.filter((contact) => contact.missingChat)
  if (missingChatContacts.length > 0) {
    findings.push({
      id: 'missing-thread-coverage',
      title: 'Contacts with references but no parsed chat thread',
      type: 'coverage-gap',
      severity: 'low',
      score: 58,
      summary: 'Some contacts appear in search/friend data but have no parsed chat rows.',
      explanation:
        'This can indicate sparse exports, unsupported file shapes, or contacts that only appear outside saved chat history.',
      evidenceIds: missingChatContacts.flatMap((contact) => contact.evidenceIds).slice(0, 8),
    })
  }

  const repeatedCrossUploadEntities = entities.filter((entity) => entity.uploads.length > 1)
  if (repeatedCrossUploadEntities.length > 0) {
    findings.push({
      id: 'cross-upload-entity-link',
      title: 'Cross-upload entity overlap',
      type: 'cross-upload-link',
      severity: 'low',
      score: 54,
      summary: 'Some names, handles, or locations appear across more than one uploaded export.',
      explanation:
        'This can be useful when comparing uploads over time or checking whether the same references recur.',
      evidenceIds: repeatedCrossUploadEntities.flatMap((entity) => entity.evidenceIds).slice(0, 6),
    })
  }

  const secrecyHits = keywordHits.filter((hit) => hit.category === 'secrecy')
  if (secrecyHits.length >= 2) {
    findings.push({
      id: 'secrecy-language',
      title: 'Repeated secrecy language',
      type: 'tone-pattern',
      severity: 'medium',
      score: 76,
      summary: 'Several message snippets matched secrecy-oriented phrase rules.',
      explanation:
        'These are deterministic phrase matches, not an accusation. Review the cited excerpts directly for context.',
      evidenceIds: secrecyHits.map((hit) => hit.eventId).slice(0, 6),
    })
  }

  if (findings.length === 0) {
    findings.push({
      id: 'no-major-findings',
      title: 'No high-signal patterns',
      type: 'baseline',
      severity: 'low',
      score: 20,
      summary: 'The deterministic pass did not surface a strong cluster of notable patterns.',
      explanation:
        'This means the current rules did not find concentrated spikes, language clusters, or timing patterns above threshold.',
      evidenceIds: events.slice(-3).map((event) => event.id),
    })
  }

  return findings.sort((left, right) => right.score - left.score)
}

function buildNotablePeriods(timeline: TimelineBucket[], signals: SignalFinding[]) {
  const average = timeline.length
    ? timeline.reduce((sum, bucket) => sum + bucket.count, 0) / timeline.length
    : 0

  const notable = timeline
    .filter((bucket) => bucket.count >= Math.max(4, average * 1.35))
    .sort((left, right) => right.count - left.count)
    .slice(0, 4)

  return notable.map(
    (bucket, index): NotablePeriod => ({
      id: `period-${bucket.key}`,
      label: `Notable period ${index + 1}`,
      start: bucket.key,
      end: bucket.key,
      summary:
        signals[0]?.summary ??
        'High event density and mixed activity categories made this period stand out.',
      evidenceIds: bucket.evidenceIds.slice(0, 6),
    }),
  )
}

function buildStats(
  events: NormalizedEvent[],
  contacts: ContactSummary[],
  entities: EntitySummary[],
  uploads: ParsedUpload[],
  fileSummaries: WorkspaceDataset['fileSummaries'],
): DatasetStats {
  const dated = events
    .map((event) => event.timestamp)
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => left.localeCompare(right))

  return {
    totalEvents: events.length,
    chatEvents: events.filter((event) => event.category === 'chat').length,
    locationEvents: events.filter((event) => event.category === 'location').length,
    loginEvents: events.filter((event) => event.category === 'login').length,
    searchEvents: events.filter((event) => event.category === 'search').length,
    memoryEvents: events.filter((event) => event.category === 'memory').length,
    uniqueContacts: contacts.length,
    uniqueEntities: entities.length,
    uploads: uploads.length,
    supportedFiles: fileSummaries.filter((file) => file.supported).length,
    unsupportedFiles: fileSummaries.filter((file) => !file.supported).length,
    missingChatContacts: contacts.filter((contact) => contact.missingChat).length,
    deletionIndicators: events.filter(matchesDeletionIndicator).length,
    dateRange: {
      start: dated[0] ?? null,
      end: dated[dated.length - 1] ?? null,
    },
  }
}

function buildFactsSummary(
  stats: DatasetStats,
  uploads: ParsedUpload[],
  contacts: ContactSummary[],
  entities: EntitySummary[],
  signals: SignalFinding[],
) {
  const topContact = contacts[0]
  const topEntity = entities[0]

  return [
    `${uploads.length} upload${uploads.length === 1 ? '' : 's'} loaded with ${stats.totalEvents} normalized events.`,
    stats.dateRange.start && stats.dateRange.end
      ? `Observed activity spans from ${formatDayLabel(stats.dateRange.start)} to ${formatDayLabel(stats.dateRange.end)}.`
      : 'No valid date range was recovered from the current data.',
    topContact
      ? `${topContact.name} is currently the most active contact with ${topContact.interactions} linked events and ${topContact.messageCount} chat rows.`
      : 'No recurring contacts were identified in the current data.',
    stats.missingChatContacts > 0
      ? `${stats.missingChatContacts} contact${stats.missingChatContacts === 1 ? '' : 's'} appear in friend/search metadata without a parsed chat thread.`
      : 'Every identified contact has at least one parsed thread or linked chat row.',
    stats.deletionIndicators > 0
      ? `${stats.deletionIndicators} event${stats.deletionIndicators === 1 ? '' : 's'} contain deletion, removal, or cleanup-style indicators.`
      : 'No deletion or removal indicators were detected by the current rule set.',
    topEntity
      ? `Top extracted entity: ${topEntity.value} (${topEntity.type}) seen ${topEntity.count} times.`
      : 'No repeated structured entities were extracted.',
    signals[0]
      ? `Highest-priority signal: ${signals[0].title}.`
      : 'No notable deterministic signals were produced.',
  ]
}

function dedupeWarnings(uploads: ParsedUpload[]) {
  return [...new Set(uploads.flatMap((upload) => upload.upload.warnings))]
}

export function buildWorkspace(uploads: ParsedUpload[]): WorkspaceDataset {
  const fileSummaries = uploads.flatMap((upload) => upload.fileSummaries)
  const events = uploads
    .flatMap((upload) => upload.events)
    .sort((left, right) => {
      if (!left.timestamp && !right.timestamp) {
        return left.id.localeCompare(right.id)
      }
      if (!left.timestamp) {
        return 1
      }
      if (!right.timestamp) {
        return -1
      }
      return left.timestamp.localeCompare(right.timestamp)
    })

  const keywordHits = collectKeywordHits(events)
  const contacts = buildContacts(events, keywordHits, buildSelfAliasLookup(uploads))
  const entities = buildEntities(events)
  const repeatedPhrases = buildRepeatedPhrases(events)
  const toneSummaries = buildToneSummaries(keywordHits)
  const timeline = buildTimeline(events)
  const activitySource = events.filter((event) => event.category === 'chat')
  const { hourBuckets, weekdayBuckets, heatmap } = buildActivityBuckets(
    activitySource.length ? activitySource : events,
  )
  const signals = buildSignals(events, contacts, entities, keywordHits, timeline)
  const notablePeriods = buildNotablePeriods(timeline, signals)
  const evidenceIds = [
    ...signals.flatMap((signal) => signal.evidenceIds),
    ...notablePeriods.flatMap((period) => period.evidenceIds),
  ]
  const evidenceSnippets = buildEvidenceSnippets(events, [...new Set(evidenceIds)])
  const stats = buildStats(events, contacts, entities, uploads, fileSummaries)
  const factsSummary = buildFactsSummary(stats, uploads, contacts, entities, signals)

  return {
    uploads: uploads.map((upload) => upload.upload),
    fileSummaries,
    events,
    stats,
    accountProfiles: uploads.map((upload) => upload.upload.account),
    contacts,
    keywordHits,
    signals,
    entities,
    repeatedPhrases,
    toneSummaries,
    timeline,
    hourBuckets,
    weekdayBuckets,
    heatmap,
    notablePeriods,
    evidenceSnippets,
    factsSummary,
    warnings: dedupeWarnings(uploads),
  }
}

export function buildWorkspaceLite(uploads: ParsedUpload[]): WorkspaceDataset {
  const fileSummaries = uploads.flatMap((upload) => upload.fileSummaries)
  const events = uploads
    .flatMap((upload) => upload.events)
    .sort((left, right) => {
      if (!left.timestamp && !right.timestamp) {
        return left.id.localeCompare(right.id)
      }
      if (!left.timestamp) {
        return 1
      }
      if (!right.timestamp) {
        return -1
      }
      return left.timestamp.localeCompare(right.timestamp)
    })

  const contacts = buildContacts(events, [], buildSelfAliasLookup(uploads))
  const timeline = buildTimeline(events)
  const activitySource = events.filter((event) => event.category === 'chat')
  const { hourBuckets, weekdayBuckets, heatmap } = buildActivityBuckets(
    activitySource.length ? activitySource : events,
  )
  const stats = buildStats(events, contacts, [], uploads, fileSummaries)
  const factsSummary = [
    `${uploads.length} upload${uploads.length === 1 ? '' : 's'} loaded with ${stats.totalEvents} normalized events.`,
    contacts[0]
      ? `${contacts[0].name} is currently the most active contact with ${contacts[0].messageCount} visible chat rows.`
      : 'No contacts were recovered from the current export.',
    'Advanced workspace patterning is paused by default. Open one contact and run AI only when needed.',
  ]

  return {
    uploads: uploads.map((upload) => upload.upload),
    fileSummaries,
    events,
    stats,
    accountProfiles: uploads.map((upload) => upload.upload.account),
    contacts,
    keywordHits: [],
    signals: [],
    entities: [],
    repeatedPhrases: [],
    toneSummaries: [],
    timeline,
    hourBuckets,
    weekdayBuckets,
    heatmap,
    notablePeriods: [],
    evidenceSnippets: [],
    factsSummary,
    warnings: dedupeWarnings(uploads),
  }
}

export function buildWorkspaceReport(workspace: WorkspaceDataset) {
  return {
    generatedAt: new Date().toISOString(),
    uploads: workspace.uploads,
    stats: workspace.stats,
    topContacts: workspace.contacts.slice(0, 12),
    topEntities: workspace.entities.slice(0, 16),
    repeatedPhrases: workspace.repeatedPhrases,
    notablePeriods: workspace.notablePeriods,
    signals: workspace.signals,
    factsSummary: workspace.factsSummary,
    evidenceSnippets: workspace.evidenceSnippets,
  }
}
