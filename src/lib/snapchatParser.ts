import JSZip from 'jszip'
import Papa from 'papaparse'
import type {
  AccountProfile,
  DataCategory,
  FileSummary,
  NormalizedEvent,
  NormalizedValue,
  ParsedUpload,
  UploadSummary,
} from '../types'

type FlatRecord = Record<string, NormalizedValue>

const SUPPORTED_EXTENSIONS = ['.json', '.csv', '.html', '.htm', '.txt']
const ACCOUNT_KEYS = ['username', 'display', 'email', 'phone', 'mobile', 'profile', 'account']
const MEDIA_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.mp4',
  '.mov',
  '.webm',
  '.heic',
  '.avi',
  '.mkv',
  '.wav',
  '.mp3',
]
const GENERIC_CONTACT_TERMS = new Set([
  'account information',
  'bitmoji',
  'chat history',
  'download my data',
  'friends',
  'home',
  'index',
  'location',
  'login history',
  'memories',
  'my data',
  'profiles',
  'purchase history',
  'saved chat history',
  'search history',
  'snap history',
  'snapchat support history',
  'support history',
])
const HTML_NOISE_TERMS = new Set([
  'account',
  'account information',
  'bitmoji',
  'download my data',
  'friends',
  'home',
  'location',
  'login history and account information',
  'memories',
  'my data',
  'purchase & shop history',
  'saved chat history',
  'search history',
  'snap history',
  'snapchat support history',
  'support history',
  'user & public profiles',
])
const SNAPCHAT_TIMESTAMP_PATTERN = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/g
const SNAPCHAT_TRANSCRIPT_STATUSES = ['Saved', 'Opened', 'Received', 'Delivered', 'Sent'] as const
const SNAPCHAT_TRANSCRIPT_MARKERS = ['TEXT', 'MEDIA', 'CALL', 'NOTE'] as const
const EMBEDDED_TRANSCRIPT_PATTERN =
  /UTC(Saved|Opened|Received|Delivered|Sent)([A-Za-z0-9._-]{2,40})(TEXT|MEDIA|CALL|NOTE)/g

type ParseProgress = {
  percent: number
  label: string
}

type ParseProgressHandler = (progress: ParseProgress) => void

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

function extensionOf(path: string) {
  const index = path.lastIndexOf('.')
  return index >= 0 ? path.slice(index).toLowerCase() : ''
}

function baseName(path: string) {
  const normalized = path.replace(/\\/g, '/')
  const lastSegment = normalized.split('/').pop() ?? normalized
  return lastSegment.replace(/\.[^.]+$/, '')
}

function hasSupportedExtension(path: string) {
  return SUPPORTED_EXTENSIONS.includes(extensionOf(path))
}

function isMediaExtension(path: string) {
  return MEDIA_EXTENSIONS.includes(extensionOf(path))
}

function sanitizeContactCandidate(value: string | null, path: string) {
  if (!value) {
    return null
  }

  const trimmed = value
    .replace(/\.[^.]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!trimmed) {
    return null
  }

  const lower = trimmed.toLowerCase()
  if (GENERIC_CONTACT_TERMS.has(lower)) {
    return null
  }

  if (lower === baseName(path).toLowerCase() && GENERIC_CONTACT_TERMS.has(lower)) {
    return null
  }

  return trimmed
}

function normalizeHtmlLine(line: string) {
  return line
    .replace(/<[^>]+>/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function looksLikeStructuredBlob(value: string) {
  const compact = value.replace(/\s+/g, ' ').trim()
  if (!compact) {
    return false
  }

  return (
    /<\/?[a-z][^>]*>/i.test(compact) ||
    (/^[[{]/.test(compact) && /[:",]/.test(compact)) ||
    /\b(function|const|let|var|return|document\.|window\.|className|querySelector)\b/.test(compact) ||
    /"[\w.-]+"\s*:/.test(compact) ||
    compact.includes('{"') ||
    compact.includes('":["')
  )
}

function sanitizeReadableText(value: string | null) {
  if (!value) {
    return null
  }

  const normalized = normalizeHtmlLine(value)
  if (!normalized) {
    return null
  }

  if (HTML_NOISE_TERMS.has(normalized.toLowerCase())) {
    return null
  }

  if (looksLikeStructuredBlob(normalized)) {
    return null
  }

  return normalized
}

function isNoiseHtmlLine(line: string) {
  const normalized = normalizeHtmlLine(line)
  if (!normalized) {
    return true
  }

  const lower = normalized.toLowerCase()
  if (HTML_NOISE_TERMS.has(lower)) {
    return true
  }

  if (lower.length < 2) {
    return true
  }

  return false
}

function extractTimestampFragment(value: string) {
  const patterns = [
    /\b\d{4}-\d{2}-\d{2}(?:[ t]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?: ?(?:am|pm))?(?: ?(?:z|utc|gmt|[+-]\d{2}:?\d{2}))?)?\b/i,
    /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}(?:,? \d{1,2}:\d{2}(?::\d{2})?(?: ?[ap]m)?)?\b/i,
    /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]* \d{1,2},? \d{2,4}(?:,? \d{1,2}:\d{2}(?::\d{2})?(?: ?[ap]m)?)?\b/i,
  ]

  for (const pattern of patterns) {
    const match = value.match(pattern)
    if (match?.[0]) {
      return match[0]
    }
  }

  return null
}

function buildHtmlLineRecords(content: string) {
  const rawLines = content.split(/\r?\n/).map((line) => normalizeHtmlLine(line))
  const lines = rawLines.filter((line, index) => {
    if (isNoiseHtmlLine(line)) {
      return false
    }

    return line !== rawLines[index - 1]
  })

  const records: FlatRecord[] = []
  let pendingTimestamp: string | null = null

  lines.forEach((line, index) => {
    const record: FlatRecord = {
      line,
      row: index + 1,
    }

    const timestamp = extractTimestampFragment(line)
    if (timestamp) {
      record.timestamp = timestamp
      const withoutTimestamp = normalizeHtmlLine(line.replace(timestamp, ''))
      if (withoutTimestamp) {
        record.line = withoutTimestamp
      } else {
        pendingTimestamp = timestamp
        return
      }
    } else if (pendingTimestamp) {
      record.timestamp = pendingTimestamp
      pendingTimestamp = null
    }

    const pairMatch = record.line && String(record.line).match(/^([A-Za-z][A-Za-z _-]{1,32}):\s+(.+)$/)
    if (pairMatch) {
      const key = pairMatch[1].trim().toLowerCase().replace(/\s+/g, '_')
      const value = pairMatch[2].trim()
      record[key] = value
      if (['sender', 'from', 'to', 'contact', 'friend', 'participant', 'recipient', 'name'].includes(key)) {
        record.contact = value
      }
      if (['message', 'chat', 'text', 'body', 'caption', 'content'].includes(key)) {
        record.message = value
      }
    } else {
      const chatLike = String(record.line).match(/^([^:]{2,48}):\s+(.+)$/)
      if (chatLike) {
        record.contact = chatLike[1].trim()
        record.message = chatLike[2].trim()
      }
    }

    records.push(record)
  })

  return records
}

function extractTranscriptRecords(content: string) {
  const matches = [...content.matchAll(SNAPCHAT_TIMESTAMP_PATTERN)]
  if (matches.length < 2 && !content.includes('TEXT')) {
    return []
  }

  const records: FlatRecord[] = []

  function pushTranscriptParts(timestamp: string, status: string | null, contact: string, marker: string, message: string) {
    const embedded = [...message.matchAll(EMBEDDED_TRANSCRIPT_PATTERN)]
    if (!embedded.length) {
      records.push({
        timestamp,
        status: status ?? 'Saved',
        contact,
        marker,
        message,
      })
      return
    }

    let previousIndex = 0
    embedded.forEach((match, index) => {
      const start = match.index ?? 0
      const firstChunk = message.slice(previousIndex, start).replace(/\s+/g, ' ').trim()
      if (index === 0 && firstChunk) {
        records.push({
          timestamp,
          status: status ?? 'Saved',
          contact,
          marker,
          message: firstChunk,
        })
      }

      const nextStart = embedded[index + 1]?.index ?? message.length
      const nestedMessage = message
        .slice(start + match[0].length, nextStart)
        .replace(/^[,:;\s"'`]+/, '')
        .replace(/\s+/g, ' ')
        .trim()

      if (nestedMessage) {
        records.push({
          timestamp,
          status: match[1] ?? 'Saved',
          contact: match[2] ?? contact,
          marker: match[3] ?? marker,
          message: nestedMessage,
        })
      }

      previousIndex = nextStart
    })
  }

  matches.forEach((match, index) => {
    const timestamp = match[0]?.trim() ?? null
    const start = match.index ?? 0
    const nextStart = matches[index + 1]?.index ?? content.length
    let segment = content
      .slice(start + (match[0]?.length ?? 0), nextStart)
      .replace(/^[,:;\s"'`]+/, '')
      .trim()

    if (!timestamp || !segment) {
      return
    }

    let status: string | null = null
    for (const candidate of SNAPCHAT_TRANSCRIPT_STATUSES) {
      if (segment.startsWith(candidate)) {
        status = candidate
        segment = segment.slice(candidate.length).trim()
        break
      }
    }

    const marker = SNAPCHAT_TRANSCRIPT_MARKERS.find((candidate) => segment.includes(candidate)) ?? null
    if (!marker) {
      return
    }

    const markerIndex = segment.indexOf(marker)
    const contact = segment.slice(0, markerIndex).trim()
    let message = segment.slice(markerIndex + marker.length)
    message = message
      .replace(/^[,:;\s"'`]+/, '')
      .replace(/\s+/g, ' ')
      .trim()

    if (!contact || !message) {
      return
    }

    pushTranscriptParts(timestamp, status, contact, marker ?? 'TEXT', message)
  })

  return records
}

function detectCategory(path: string, records: FlatRecord[]): DataCategory {
  const lower = path.toLowerCase()
  const keys = records.slice(0, 5).flatMap((record) => Object.keys(record).map((key) => key.toLowerCase()))

  if (
    lower.includes('account') ||
    lower.includes('profile') ||
    lower.includes('user_public_profile') ||
    lower.includes('public_profile') ||
    keys.some((key) => ACCOUNT_KEYS.some((needle) => key.includes(needle)))
  ) {
    return 'account'
  }

  if (
    lower.includes('bitmoji') ||
    keys.some((key) => key.includes('bitmoji'))
  ) {
    return 'bitmoji'
  }

  if (
    lower.includes('chat') ||
    lower.includes('conversation') ||
    lower.includes('message') ||
    lower.includes('saved_chat') ||
    lower.includes('snap_history') ||
    keys.some((key) => ['message', 'chat', 'text', 'body'].some((needle) => key.includes(needle)))
  ) {
    return 'chat'
  }

  if (
    lower.includes('support') ||
    keys.some((key) => ['ticket', 'support_case', 'support'].some((needle) => key.includes(needle)))
  ) {
    return 'support'
  }

  if (
    lower.includes('friend') ||
    lower.includes('friends') ||
    keys.some((key) => key.includes('friend'))
  ) {
    return 'friend'
  }

  if (
    lower.includes('purchase') ||
    lower.includes('shop') ||
    keys.some((key) => ['purchase', 'order', 'item'].some((needle) => key.includes(needle)))
  ) {
    return 'purchase'
  }

  if (
    lower.includes('location') ||
    lower.includes('snap_map') ||
    keys.some((key) => ['location', 'latitude', 'longitude', 'address'].some((needle) => key.includes(needle)))
  ) {
    return 'location'
  }

  if (
    lower.includes('login') ||
    lower.includes('device') ||
    lower.includes('session') ||
    lower.includes('login_history') ||
    keys.some((key) => ['device', 'session', 'ip', 'login'].some((needle) => key.includes(needle)))
  ) {
    return 'login'
  }

  if (
    lower.includes('memories') ||
    lower.includes('memory') ||
    lower.includes('media') ||
    keys.some((key) => ['filename', 'media'].some((needle) => key.includes(needle)))
  ) {
    return 'memory'
  }

  if (
    lower.includes('search') ||
    lower.includes('search_history') ||
    keys.some((key) => key.includes('query'))
  ) {
    return 'search'
  }

  return 'unknown'
}

function flattenObject(value: unknown, prefix = '', target: FlatRecord = {}): FlatRecord {
  if (value === null || value === undefined) {
    return target
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      flattenObject(item, prefix ? `${prefix}.${index}` : String(index), target)
    })
    return target
  }

  if (typeof value === 'object') {
    Object.entries(value as Record<string, unknown>).forEach(([key, nested]) => {
      const nextPrefix = prefix ? `${prefix}.${key}` : key
      flattenObject(nested, nextPrefix, target)
    })
    return target
  }

  target[prefix] = value as NormalizedValue
  return target
}

function looksLikeRecord(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const flattened = flattenObject(value)
  const keys = Object.keys(flattened)
  if (keys.length < 2) {
    return false
  }

  return keys.some((key) =>
    ['time', 'date', 'message', 'user', 'friend', 'query', 'location', 'device'].some((needle) =>
      key.toLowerCase().includes(needle),
    ),
  )
}

function collectRecords(value: unknown): FlatRecord[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectRecords(item))
  }

  if (!value || typeof value !== 'object') {
    return []
  }

  if (looksLikeRecord(value)) {
    return [flattenObject(value)]
  }

  return Object.values(value as Record<string, unknown>).flatMap((item) => collectRecords(item))
}

function parseCsv(content: string): FlatRecord[] {
  const parsed = Papa.parse<Record<string, string>>(content, {
    header: true,
    skipEmptyLines: true,
  })

  return (parsed.data ?? []).map((record) =>
    Object.fromEntries(
      Object.entries(record).map(([key, value]) => [key, value ? value.trim() : null]),
    ),
  )
}

function parseHtml(content: string): FlatRecord[] {
  const transcriptRecords = extractTranscriptRecords(content)
  if (transcriptRecords.length > 0) {
    return transcriptRecords
  }

  const document = new DOMParser().parseFromString(content, 'text/html')
  const tables = [...document.querySelectorAll('table')]
  const tableRecords = tables.flatMap((table) => {
    const rows = [...table.querySelectorAll('tr')]
    if (rows.length < 2) {
      return []
    }

    const headers = [...rows[0].querySelectorAll('th,td')].map((cell, index) =>
      cell.textContent?.trim() || `column_${index + 1}`,
    )

    return rows.slice(1).map((row) =>
      Object.fromEntries(
        headers.map((header, index) => [
          header,
          row.querySelectorAll('td,th')[index]?.textContent?.trim() || null,
        ]),
      ),
    )
  })

  const fallbackRecords = buildHtmlLineRecords(document.body?.innerText ?? '')
  const combined = [...tableRecords, ...fallbackRecords]

  if (combined.length > 0) {
    return combined
  }

  return [...document.querySelectorAll('li,p,h1,h2,h3,h4,div')]
    .map((node, index) => ({
      [`line_${index + 1}`]: sanitizeReadableText(node.textContent ?? ''),
    }))
    .filter((record) => {
      const value = Object.values(record)[0]
      return typeof value === 'string' && value.length >= 2
    })
}

function parseJson(content: string): FlatRecord[] {
  try {
    return collectRecords(JSON.parse(content))
  } catch {
    return []
  }
}

function parseTxt(content: string): FlatRecord[] {
  const transcriptRecords = extractTranscriptRecords(content)
  if (transcriptRecords.length > 0) {
    return transcriptRecords
  }

  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => ({
      line,
      row: index + 1,
    }))
}

function parseByExtension(path: string, content: string) {
  const extension = extensionOf(path)

  if (extension === '.json') {
    return parseJson(content)
  }
  if (extension === '.csv') {
    return parseCsv(content)
  }
  if (extension === '.html' || extension === '.htm') {
    return parseHtml(content)
  }

  return parseTxt(content)
}

async function fileToText(file: File, onProgress?: (percent: number) => void) {
  if (!onProgress) {
    return file.text()
  }

  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()

    reader.addEventListener('progress', (event) => {
      if (event.lengthComputable) {
        onProgress((event.loaded / event.total) * 100)
      }
    })
    reader.addEventListener('load', () => resolve(String(reader.result ?? '')))
    reader.addEventListener('error', () => reject(reader.error ?? new Error('File read failed.')))
    reader.readAsText(file)
  })
}

function pickString(record: FlatRecord, needles: string[]) {
  const entry = Object.entries(record).find(([key, value]) => {
    const lower = key.toLowerCase()
    return needles.some((needle) => lower.includes(needle)) && value !== null && value !== ''
  })

  return entry?.[1] !== undefined && entry[1] !== null ? String(entry[1]) : null
}

function pickNumber(record: FlatRecord, needles: string[]) {
  const value = pickString(record, needles)
  if (!value) {
    return null
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function derivePathContact(path: string) {
  const stem = baseName(path)
  const normalized = stem
    .replace(/[_-]+/g, ' ')
    .replace(/\b(chat|history|saved|conversation|messages|snap|export|data)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized || normalized.length < 2) {
    return null
  }

  if (/^\d+$/.test(normalized)) {
    return null
  }

  return sanitizeContactCandidate(normalized, path)
}

function normalizeTimestamp(value: string | null) {
  if (!value) {
    return null
  }

  const extracted = extractTimestampFragment(value) ?? value
  const numeric = Number(value)
  const normalizedText = extracted
    .replace(' UTC', 'Z')
    .replace(/(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/, '$1T$2')
  const date = Number.isFinite(numeric)
    ? new Date(String(value).length >= 13 ? numeric : numeric * 1000)
    : new Date(normalizedText)

  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function deriveSubtype(record: FlatRecord) {
  return (
    pickString(record, ['status', 'type', 'action', 'category', 'event']) ??
    pickString(record, ['query', 'message', 'device']) ??
    null
  )
}

function eventEvidenceText(record: FlatRecord) {
  return Object.values(record)
    .filter((value) => typeof value === 'string' || typeof value === 'number')
    .slice(0, 12)
    .join(' ')
}

function pickContact(record: FlatRecord, category: DataCategory, path: string) {
  const direct =
    sanitizeContactCandidate(
      pickString(record, [
      'friend',
      'contact',
      'display_name',
      'participant',
      'recipient',
      'sender',
      'from',
      'to',
      'conversation_title',
      'display',
      'friend_name',
      'recipient_name',
    ]) ??
        pickString(record, ['username', 'user', 'handle']),
      path,
    )

  if (direct) {
    return direct
  }

  if (category === 'chat' || category === 'friend' || category === 'search') {
    return sanitizeContactCandidate(
      pickString(record, ['name', 'conversation', 'title']) ?? derivePathContact(path),
      path,
    )
  }

  return null
}

function pickEventText(record: FlatRecord) {
  const candidate = pickString(record, [
    'message',
    'chat',
    'content',
    'body',
    'text',
    'caption',
    'savedchat',
    'snap_caption',
    'line',
    'description',
    'title',
    'note',
  ])

  if (!candidate) {
    return null
  }

  return sanitizeReadableText(candidate)
}

function normalizeEvent(
  uploadId: string,
  path: string,
  category: DataCategory,
  record: FlatRecord,
  index: number,
) {
  const event: NormalizedEvent = {
    id: `${uploadId}:${slugify(path)}:${index}`,
    uploadId,
    category,
    subtype: deriveSubtype(record),
    sourceFile: path,
    timestamp: normalizeTimestamp(
      pickString(record, ['timestamp', 'created', 'saved', 'sent', 'date', 'time']),
    ),
    contact: pickContact(record, category, path),
    text: pickEventText(record),
    detail:
      pickString(record, ['query', 'filename', 'email', 'ip', 'status', 'device', 'action']) ?? null,
    locationName: pickString(record, ['location', 'place', 'city', 'address']),
    latitude: pickNumber(record, ['latitude', 'lat']),
    longitude: pickNumber(record, ['longitude', 'lng', 'lon']),
    device: pickString(record, ['device', 'model', 'platform']),
    region: pickString(record, ['region', 'country', 'state', 'ip']),
    evidenceText: eventEvidenceText(record),
    attributes: record,
  }

  return event
}

function buildEmptyAccount(): AccountProfile {
  return {
    username: null,
    displayName: null,
    email: null,
    phone: null,
    region: null,
    aliases: [],
  }
}

function enrichAccount(account: AccountProfile, record: FlatRecord) {
  const next = { ...account }
  next.username =
    next.username ??
    pickString(record, ['username', 'user_name', 'user']) ??
    null
  next.displayName =
    next.displayName ??
    pickString(record, ['display_name', 'display', 'name']) ??
    null
  next.email = next.email ?? pickString(record, ['email']) ?? null
  next.phone = next.phone ?? pickString(record, ['phone', 'mobile']) ?? null
  next.region = next.region ?? pickString(record, ['region', 'country', 'state']) ?? null

  ;[next.username, next.displayName, next.email, next.phone]
    .filter((value): value is string => Boolean(value))
    .forEach((value) => {
      if (!next.aliases.includes(value)) {
        next.aliases.push(value)
      }
    })

  return next
}

export async function parseSnapchatZip(
  file: File,
  onProgress?: ParseProgressHandler,
): Promise<ParsedUpload> {
  const uploadId = slugify(`${file.name}-${file.lastModified}`)
  const zip = await JSZip.loadAsync(file)
  const events: NormalizedEvent[] = []
  const fileSummaries: FileSummary[] = []
  const warnings: string[] = []
  let account = buildEmptyAccount()

  const allEntries = Object.values(zip.files).filter((entry) => !entry.dir)
  const supportedEntries = allEntries.filter((entry) => hasSupportedExtension(entry.name))
  const skippedMediaEntries = allEntries.filter((entry) => isMediaExtension(entry.name))
  const totalSteps = Math.max(supportedEntries.length + 1, 1)
  let completedSteps = 0

  onProgress?.({
    percent: 5,
    label: `Opened zip with ${supportedEntries.length} supported file${supportedEntries.length === 1 ? '' : 's'}.`,
  })

  for (const entry of supportedEntries) {
    try {
      const content = await entry.async('text', (metadata) => {
        onProgress?.({
          percent: Math.min(
            95,
            ((completedSteps + metadata.percent / 100) / totalSteps) * 100,
          ),
          label: `Parsing ${entry.name} (${Math.round(metadata.percent)}%)`,
        })
      })
      const records = parseByExtension(entry.name, content)
      const category = detectCategory(entry.name, records)
      const normalized = records
        .map((record, index) => normalizeEvent(uploadId, entry.name, category, record, index))
        .filter((event) => {
          if (category === 'unknown') {
            return Boolean(
              event.timestamp ||
                event.contact ||
                event.text ||
                event.detail ||
                event.locationName,
            )
          }

          return true
        })

      if (category === 'account') {
        records.forEach((record) => {
          account = enrichAccount(account, record)
        })
      }

      events.push(...normalized)
      fileSummaries.push({
        uploadId,
        path: entry.name,
        extension: extensionOf(entry.name),
        category,
        rows: normalized.length,
        supported: true,
      })
      completedSteps += 1
      onProgress?.({
        percent: Math.min(95, (completedSteps / totalSteps) * 100),
        label: `Parsed ${completedSteps} of ${supportedEntries.length} supported files.`,
      })
    } catch (error) {
      warnings.push(
        `Could not parse ${entry.name}: ${error instanceof Error ? error.message : 'unknown error'}`,
      )
      completedSteps += 1
      onProgress?.({
        percent: Math.min(95, (completedSteps / totalSteps) * 100),
        label: `Parsed ${completedSteps} of ${supportedEntries.length} supported files.`,
      })
    }
  }

  allEntries
    .filter((entry) => !hasSupportedExtension(entry.name))
    .forEach((entry) => {
      fileSummaries.push({
        uploadId,
        path: entry.name,
        extension: extensionOf(entry.name),
        category: 'unknown',
        rows: 0,
        supported: false,
      })
    })

  const categoryCounts = events.reduce<Partial<Record<DataCategory, number>>>((counts, event) => {
    counts[event.category] = (counts[event.category] ?? 0) + 1
    return counts
  }, {})

  const upload: UploadSummary = {
    id: uploadId,
    fileName: file.name,
    sizeBytes: file.size,
    uploadedAt: new Date(file.lastModified || Date.now()).toISOString(),
    processedAt: new Date().toISOString(),
    totalFiles: allEntries.length,
    supportedFiles: supportedEntries.length,
    unsupportedFiles: allEntries.length - supportedEntries.length,
    categoryCounts,
    account,
    warnings,
  }

  if (skippedMediaEntries.length > 0) {
    upload.warnings.push(
      `Skipped ${skippedMediaEntries.length} media file${skippedMediaEntries.length === 1 ? '' : 's'} and only parsed text-based export data.`,
    )
  }

  onProgress?.({
    percent: 94,
    label: `Zip parse finished with ${events.length} normalized rows. Building thread index...`,
  })

  return {
    upload,
    fileSummaries: fileSummaries.sort((left, right) => right.rows - left.rows),
    events: events.sort((left, right) => {
      if (!left.timestamp) {
        return 1
      }
      if (!right.timestamp) {
        return -1
      }
      return left.timestamp.localeCompare(right.timestamp)
    }),
  }
}

export async function parseSnapchatFileList(
  files: File[],
  onProgress?: ParseProgressHandler,
): Promise<ParsedUpload> {
  const uploadId = slugify(`folder-${files[0]?.name ?? 'export'}-${Date.now()}`)
  const warnings: string[] = []
  const fileSummaries: FileSummary[] = []
  const events: NormalizedEvent[] = []
  let account = buildEmptyAccount()

  const supportedFiles = files.filter((file) =>
    hasSupportedExtension(file.webkitRelativePath || file.name),
  )
  const skippedMedia = files.filter((file) => isMediaExtension(file.webkitRelativePath || file.name))
  const totalSteps = Math.max(supportedFiles.length, 1)
  let completedSteps = 0

  for (const file of supportedFiles) {
    const path = file.webkitRelativePath || file.name

    try {
      const content = await fileToText(file, (filePercent) => {
        onProgress?.({
          percent: ((completedSteps + filePercent / 100) / totalSteps) * 100,
          label: `Reading ${completedSteps + 1} of ${supportedFiles.length} supported files.`,
        })
      })
      const records = parseByExtension(path, content)
      const category = detectCategory(path, records)
      const normalized = records
        .map((record, index) => normalizeEvent(uploadId, path, category, record, index))
        .filter((event) => {
          if (category === 'unknown') {
            return Boolean(
              event.timestamp ||
                event.contact ||
                event.text ||
                event.detail ||
                event.locationName,
            )
          }

          return true
        })

      if (category === 'account') {
        records.forEach((record) => {
          account = enrichAccount(account, record)
        })
      }

      events.push(...normalized)
      fileSummaries.push({
        uploadId,
        path,
        extension: extensionOf(path),
        category,
        rows: normalized.length,
        supported: true,
      })
    } catch (error) {
      warnings.push(
        `Could not parse ${path}: ${error instanceof Error ? error.message : 'unknown error'}`,
      )
    } finally {
      completedSteps += 1
      onProgress?.({
        percent: (completedSteps / totalSteps) * 100,
        label: `Parsed ${completedSteps} of ${supportedFiles.length} supported files.`,
      })
    }
  }

  files
    .filter((file) => !hasSupportedExtension(file.webkitRelativePath || file.name))
    .forEach((file) => {
      const path = file.webkitRelativePath || file.name
      fileSummaries.push({
        uploadId,
        path,
        extension: extensionOf(path),
        category: 'unknown',
        rows: 0,
        supported: false,
      })
    })

  const categoryCounts = events.reduce<Partial<Record<DataCategory, number>>>((counts, event) => {
    counts[event.category] = (counts[event.category] ?? 0) + 1
    return counts
  }, {})

  if (skippedMedia.length > 0) {
    warnings.push(
      `Skipped ${skippedMedia.length} media file${skippedMedia.length === 1 ? '' : 's'} and parsed the remaining text data directly from the extracted export folder.`,
    )
  }

  onProgress?.({
    percent: 94,
    label: `Folder parse finished with ${events.length} normalized rows. Building thread index...`,
  })

  return {
    upload: {
      id: uploadId,
      fileName: files[0]?.webkitRelativePath?.split('/')[0] || 'extracted-export',
      sizeBytes: files.reduce((sum, file) => sum + file.size, 0),
      uploadedAt: new Date().toISOString(),
      processedAt: new Date().toISOString(),
      totalFiles: files.length,
      supportedFiles: supportedFiles.length,
      unsupportedFiles: files.length - supportedFiles.length,
      categoryCounts,
      account,
      warnings,
    },
    fileSummaries: fileSummaries.sort((left, right) => right.rows - left.rows),
    events: events.sort((left, right) => {
      if (!left.timestamp) {
        return 1
      }
      if (!right.timestamp) {
        return -1
      }
      return left.timestamp.localeCompare(right.timestamp)
    }),
  }
}
