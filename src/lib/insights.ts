import type {
  ContactSummary,
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

const TONE_RULES = [
  {
    category: 'affection',
    label: 'Affection indicators',
    phrases: ['miss you', 'thinking about you', 'wish you were here', 'love you'],
  },
  {
    category: 'secrecy',
    label: 'Secrecy indicators',
    phrases: ['delete this', "don't tell", 'keep this between us', 'do not tell'],
  },
  {
    category: 'planning',
    label: 'Private planning indicators',
    phrases: ['come over', 'when can i see you', 'meet me', 'are you free'],
  },
  {
    category: 'romantic',
    label: 'Romantic tone indicators',
    phrases: ['beautiful', 'cute', 'want you', 'thinking of you'],
  },
]

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

function buildExcerpt(text: string | null) {
  const input = compact(text ?? '')
  if (!input) {
    return 'No text excerpt available.'
  }

  return input.length > 140 ? `${input.slice(0, 137)}...` : input
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

function buildContacts(events: NormalizedEvent[], keywordHits: KeywordHit[]) {
  const hitsByContact = new Map<string, KeywordHit[]>()
  keywordHits.forEach((hit) => {
    const existing = hitsByContact.get(hit.contact) ?? []
    existing.push(hit)
    hitsByContact.set(hit.contact, existing)
  })

  const { recentStart, previousStart } = recentWindowBounds(events)
  const index = new Map<string, ContactSummary>()

  events.forEach((event) => {
    if (!event.contact) {
      return
    }

    const contact = event.contact
    const current = index.get(contact) ?? {
      name: contact,
      interactions: 0,
      messageCount: 0,
      searchCount: 0,
      lateNightInteractions: 0,
      keywordHits: hitsByContact.get(contact)?.length ?? 0,
      uploads: 0,
      activeDays: 0,
      firstSeen: event.timestamp,
      lastSeen: event.timestamp,
      recentChange: 0,
      topToneLabels: [],
      evidenceIds: [],
    }

    current.interactions += 1

    if (event.category === 'chat') {
      current.messageCount += 1
    }
    if (event.category === 'search') {
      current.searchCount += 1
    }

    const date = safeDate(event.timestamp)
    if (date) {
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
    }

    if (!current.evidenceIds.includes(event.id)) {
      current.evidenceIds.push(event.id)
    }

    index.set(contact, current)
  })

  return [...index.values()]
    .map((contact) => {
      const contactEvents = events.filter((event) => event.contact === contact.name)
      const uploadCount = new Set(contactEvents.map((event) => event.uploadId)).size
      const activeDays = new Set(
        contactEvents
          .map((event) => event.timestamp?.slice(0, 10))
          .filter((value): value is string => Boolean(value)),
      ).size
      const recentCount = contactEvents.filter((event) => {
        const date = safeDate(event.timestamp)
        return date ? date.getTime() >= recentStart : false
      }).length
      const previousCount = contactEvents.filter((event) => {
        const date = safeDate(event.timestamp)
        return date
          ? date.getTime() >= previousStart && date.getTime() < recentStart
          : false
      }).length
      const topToneLabels = TONE_RULES.filter((rule) =>
        keywordHits.some(
          (hit) => hit.contact === contact.name && hit.category === rule.category,
        ),
      ).map((rule) => rule.label)

      return {
        ...contact,
        uploads: uploadCount,
        activeDays,
        recentChange: recentCount - previousCount,
        topToneLabels,
      }
    })
    .sort((left, right) => right.interactions - left.interactions)
}

function buildEntities(events: NormalizedEvent[]) {
  const entityIndex = new Map<string, EntitySummary>()

  events.forEach((event) => {
    const text = compact(
      [event.contact, event.text, event.detail, event.locationName, event.region]
        .filter(Boolean)
        .join(' '),
    )

    if (event.contact) {
      pushEntity(entityIndex, 'person', event.contact, event)
      pushEntity(entityIndex, 'username', event.contact, event)
    }
    if (event.locationName) {
      pushEntity(entityIndex, 'location', event.locationName, event)
    }

    const matches = extractMatches(text)
    matches.emails.forEach((value) => pushEntity(entityIndex, 'email', value, event))
    matches.phones.forEach((value) => pushEntity(entityIndex, 'phone', value, event))
    matches.links.forEach((value) => pushEntity(entityIndex, 'link', value, event))
    matches.handles.forEach((value) => pushEntity(entityIndex, 'handle', value, event))
  })

  return [...entityIndex.values()]
    .filter((entity) => entity.count > 0)
    .sort((left, right) => right.count - left.count)
}

function buildRepeatedPhrases(events: NormalizedEvent[]) {
  const counts = new Map<string, PhrasePattern>()
  const stopwords = new Set(['the', 'and', 'for', 'you', 'with', 'that', 'this', 'from'])

  events.forEach((event) => {
    const text = normalizeText(event.text)
    if (!text) {
      return
    }

    const words = text
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2 && !stopwords.has(word))

    for (let index = 0; index < words.length - 1; index += 1) {
      const phrase = `${words[index]} ${words[index + 1]}`
      if (phrase.length < 6) {
        continue
      }

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
    }
  })

  return [...counts.values()]
    .filter((phrase) => phrase.count > 1)
    .sort((left, right) => right.count - left.count)
    .slice(0, 12)
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

function buildHourBuckets(events: NormalizedEvent[]) {
  return Array.from({ length: 24 }, (_, hour): HourBucket => ({
    hour,
    count: events.filter((event) => {
      const date = safeDate(event.timestamp)
      return date ? date.getHours() === hour : false
    }).length,
  }))
}

function buildWeekdayBuckets(events: NormalizedEvent[]) {
  return WEEKDAY_LABELS.map((label, day): WeekdayBucket => ({
    day,
    label,
    count: events.filter((event) => {
      const date = safeDate(event.timestamp)
      return date ? date.getDay() === day : false
    }).length,
  }))
}

function buildHeatmap(events: NormalizedEvent[]) {
  const cells: HeatmapCell[] = []

  for (let day = 0; day < 7; day += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      cells.push({
        day,
        hour,
        count: events.filter((event) => {
          const date = safeDate(event.timestamp)
          return date ? date.getDay() === day && date.getHours() === hour : false
        }).length,
      })
    }
  }

  return cells
}

function buildEvidenceSnippets(events: NormalizedEvent[], evidenceIds: string[]) {
  return evidenceIds
    .map((eventId) => events.find((event) => event.id === eventId))
    .filter((event): event is NormalizedEvent => Boolean(event))
    .slice(0, 14)
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

  contacts.slice(0, 10).forEach((contact) => {
    if (contact.recentChange >= 4) {
      findings.push({
        id: `contact-change-${contact.name}`,
        title: `${contact.name}: activity shift`,
        type: 'intensity-shift',
        severity: 'high',
        score: 84,
        summary: 'Communication volume increased noticeably in the latest window.',
        explanation:
          'Recent interaction count is materially above the prior equal-length window, which makes this contact worth reviewing in context.',
        evidenceIds: contact.evidenceIds.slice(0, 4),
      })
    }

    if (contact.lateNightInteractions >= 4) {
      findings.push({
        id: `contact-night-${contact.name}`,
        title: `${contact.name}: late-night concentration`,
        type: 'time-pattern',
        severity: 'medium',
        score: 67,
        summary: 'A meaningful share of this contact activity happened overnight.',
        explanation:
          'The concentration of events between 11 PM and 5 AM is higher than typical and may be relevant to a timeline review.',
        evidenceIds: contact.evidenceIds.slice(0, 4),
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

  const repeatedCrossUploadEntities = entities.filter((entity) => entity.uploads.length > 1)
  if (repeatedCrossUploadEntities.length > 0) {
    findings.push({
      id: 'cross-upload-entity-link',
      title: 'Cross-upload entity overlap',
      type: 'cross-upload-link',
      severity: 'low',
      score: 54,
      summary: 'Some entities appear across more than one uploaded export.',
      explanation:
        'This can be useful when comparing uploads over time or checking whether the same names, handles, or locations recur.',
      evidenceIds: repeatedCrossUploadEntities.flatMap((entity) => entity.evidenceIds).slice(0, 5),
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
      evidenceIds: secrecyHits.map((hit) => hit.eventId).slice(0, 5),
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
  return timeline
    .filter((bucket) => bucket.count >= 4)
    .sort((left, right) => right.count - left.count)
    .slice(0, 3)
    .map(
      (bucket, index): NotablePeriod => ({
        id: `period-${bucket.key}`,
        label: `Notable period ${index + 1}`,
        start: bucket.key,
        end: bucket.key,
        summary:
          signals[0]?.summary ??
          'High event density and mixed activity categories made this period stand out.',
        evidenceIds: bucket.evidenceIds.slice(0, 5),
      }),
    )
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
      ? `${topContact.name} is currently the most active contact with ${topContact.interactions} linked events.`
      : 'No recurring contacts were identified in the current data.',
    topEntity
      ? `Top extracted entity: ${topEntity.value} (${topEntity.type}) seen ${topEntity.count} times.`
      : 'No repeated structured entities were extracted.',
    signals[0]
      ? `Highest-priority signal: ${signals[0].title}.`
      : 'No notable deterministic signals were produced.',
  ]
}

function buildStats(events: NormalizedEvent[], contacts: ContactSummary[], entities: EntitySummary[], uploads: ParsedUpload[]): DatasetStats {
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
    dateRange: {
      start: dated[0] ?? null,
      end: dated[dated.length - 1] ?? null,
    },
  }
}

function dedupeWarnings(uploads: ParsedUpload[]) {
  return [...new Set(uploads.flatMap((upload) => upload.upload.warnings))]
}

export function buildWorkspace(uploads: ParsedUpload[]): WorkspaceDataset {
  const fileSummaries = uploads.flatMap((upload) => upload.fileSummaries)
  const events = uploads
    .flatMap((upload) => upload.events)
    .sort((left, right) => {
      if (!left.timestamp) {
        return 1
      }
      if (!right.timestamp) {
        return -1
      }
      return left.timestamp.localeCompare(right.timestamp)
    })

  const keywordHits = collectKeywordHits(events)
  const contacts = buildContacts(events, keywordHits)
  const entities = buildEntities(events)
  const repeatedPhrases = buildRepeatedPhrases(events)
  const toneSummaries = buildToneSummaries(keywordHits)
  const timeline = buildTimeline(events)
  const hourBuckets = buildHourBuckets(events)
  const weekdayBuckets = buildWeekdayBuckets(events)
  const heatmap = buildHeatmap(events)
  const signals = buildSignals(events, contacts, entities, keywordHits, timeline)
  const notablePeriods = buildNotablePeriods(timeline, signals)
  const evidenceIds = [
    ...signals.flatMap((signal) => signal.evidenceIds),
    ...notablePeriods.flatMap((period) => period.evidenceIds),
  ]
  const evidenceSnippets = buildEvidenceSnippets(events, [...new Set(evidenceIds)])
  const stats = buildStats(events, contacts, entities, uploads)
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

export function buildWorkspaceReport(workspace: WorkspaceDataset) {
  return {
    generatedAt: new Date().toISOString(),
    uploads: workspace.uploads,
    stats: workspace.stats,
    topContacts: workspace.contacts.slice(0, 10),
    topEntities: workspace.entities.slice(0, 12),
    notablePeriods: workspace.notablePeriods,
    signals: workspace.signals,
    factsSummary: workspace.factsSummary,
    evidenceSnippets: workspace.evidenceSnippets,
  }
}
