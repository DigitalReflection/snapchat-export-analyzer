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

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

function extensionOf(path: string) {
  const index = path.lastIndexOf('.')
  return index >= 0 ? path.slice(index).toLowerCase() : ''
}

function hasSupportedExtension(path: string) {
  return SUPPORTED_EXTENSIONS.includes(extensionOf(path))
}

function detectCategory(path: string, records: FlatRecord[]): DataCategory {
  const lower = path.toLowerCase()
  const keys = records.slice(0, 5).flatMap((record) => Object.keys(record).map((key) => key.toLowerCase()))

  if (
    lower.includes('account') ||
    lower.includes('profile') ||
    keys.some((key) => ACCOUNT_KEYS.some((needle) => key.includes(needle)))
  ) {
    return 'account'
  }

  if (
    lower.includes('chat') ||
    lower.includes('conversation') ||
    lower.includes('message') ||
    keys.some((key) => ['message', 'chat', 'text', 'body'].some((needle) => key.includes(needle)))
  ) {
    return 'chat'
  }

  if (lower.includes('friend') || keys.some((key) => key.includes('friend'))) {
    return 'friend'
  }

  if (
    lower.includes('location') ||
    keys.some((key) => ['location', 'latitude', 'longitude', 'address'].some((needle) => key.includes(needle)))
  ) {
    return 'location'
  }

  if (
    lower.includes('login') ||
    lower.includes('device') ||
    lower.includes('session') ||
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

  if (lower.includes('search') || keys.some((key) => key.includes('query'))) {
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
  const document = new DOMParser().parseFromString(content, 'text/html')
  const tables = [...document.querySelectorAll('table')]

  if (tables.length > 0) {
    return tables.flatMap((table) => {
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
  }

  return [...document.querySelectorAll('li,p')]
    .map((node, index) => ({
      [`line_${index + 1}`]: node.textContent?.trim() || null,
    }))
    .filter((record) => Object.values(record)[0])
}

function parseJson(content: string): FlatRecord[] {
  try {
    return collectRecords(JSON.parse(content))
  } catch {
    return []
  }
}

function parseTxt(content: string): FlatRecord[] {
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

function normalizeTimestamp(value: string | null) {
  if (!value) {
    return null
  }

  const numeric = Number(value)
  const date = Number.isFinite(numeric)
    ? new Date(value.length >= 13 ? numeric : numeric * 1000)
    : new Date(value)

  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function deriveSubtype(record: FlatRecord) {
  return (
    pickString(record, ['status', 'type', 'action', 'category']) ??
    pickString(record, ['query', 'message', 'device']) ??
    null
  )
}

function eventEvidenceText(record: FlatRecord) {
  return Object.values(record)
    .filter((value) => typeof value === 'string' || typeof value === 'number')
    .slice(0, 8)
    .join(' ')
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
    contact:
      pickString(record, ['friend', 'contact', 'display_name', 'participant', 'recipient']) ??
      pickString(record, ['username', 'user']) ??
      null,
    text: pickString(record, ['message', 'chat', 'content', 'body', 'text']),
    detail:
      pickString(record, ['query', 'filename', 'email', 'ip', 'status', 'device']) ?? null,
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

export async function parseSnapchatZip(file: File): Promise<ParsedUpload> {
  const uploadId = slugify(`${file.name}-${file.lastModified}`)
  const zip = await JSZip.loadAsync(file)
  const events: NormalizedEvent[] = []
  const fileSummaries: FileSummary[] = []
  const warnings: string[] = []
  let account = buildEmptyAccount()

  const allEntries = Object.values(zip.files).filter((entry) => !entry.dir)
  const supportedEntries = allEntries.filter((entry) => hasSupportedExtension(entry.name))

  for (const entry of supportedEntries) {
    try {
      const content = await entry.async('text')
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
    } catch (error) {
      warnings.push(
        `Could not parse ${entry.name}: ${error instanceof Error ? error.message : 'unknown error'}`,
      )
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
