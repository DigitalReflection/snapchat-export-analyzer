import JSZip from 'jszip'
import Papa from 'papaparse'
import { buildDataset } from './heuristics'
import type { DataCategory, FileSummary, NormalizedEvent, ParsedDataset } from '../types'

type Scalar = string | number | boolean | null
type FlatRecord = Record<string, Scalar>

const SUPPORTED_EXTENSIONS = ['.json', '.csv', '.html', '.htm', '.txt']

function hasSupportedExtension(path: string) {
  return SUPPORTED_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension))
}

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

function detectCategory(path: string): DataCategory {
  const lower = path.toLowerCase()

  if (
    lower.includes('chat') ||
    lower.includes('conversation') ||
    lower.includes('message') ||
    lower.includes('snap_history')
  ) {
    return 'chat'
  }

  if (lower.includes('friend')) {
    return 'friend'
  }

  if (lower.includes('location')) {
    return 'location'
  }

  if (lower.includes('login') || lower.includes('device') || lower.includes('session')) {
    return 'login'
  }

  if (lower.includes('memories') || lower.includes('memory') || lower.includes('media')) {
    return 'memory'
  }

  if (lower.includes('search')) {
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

  target[prefix] = typeof value === 'boolean' ? String(value) : (value as Scalar)
  return target
}

function collectRecords(value: unknown): FlatRecord[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectRecords(item))
  }

  if (!value || typeof value !== 'object') {
    return []
  }

  const direct = flattenObject(value)
  const nested = Object.values(value as Record<string, unknown>).flatMap((item) =>
    collectRecords(item),
  )

  if (Object.keys(direct).length === 0) {
    return nested
  }

  return [direct, ...nested]
}

function parseCsv(content: string): FlatRecord[] {
  const parsed = Papa.parse<Record<string, string>>(content, {
    header: true,
    skipEmptyLines: true,
  })

  return (parsed.data ?? []).map((record: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(record).map(([key, value]) => [
        key,
        typeof value === 'string' ? value.trim() : null,
      ]),
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

      return rows.slice(1).map((row) => {
        const cells = [...row.querySelectorAll('td,th')]
        return Object.fromEntries(
          headers.map((header, index) => [header, cells[index]?.textContent?.trim() || null]),
        )
      })
    })
  }

  return [...document.querySelectorAll('li')]
    .slice(0, 500)
    .map((item, index) => ({
      [`line_${index + 1}`]: item.textContent?.trim() || null,
    }))
}

function parseJson(content: string): FlatRecord[] {
  try {
    const parsed = JSON.parse(content)
    return collectRecords(parsed)
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

function parseByExtension(path: string, content: string): FlatRecord[] {
  const lower = path.toLowerCase()

  if (lower.endsWith('.json')) {
    return parseJson(content)
  }

  if (lower.endsWith('.csv')) {
    return parseCsv(content)
  }

  if (lower.endsWith('.html') || lower.endsWith('.htm')) {
    return parseHtml(content)
  }

  return parseTxt(content)
}

function pickString(record: FlatRecord, needles: string[]) {
  const entry = Object.entries(record).find(([key, value]) => {
    const lowerKey = key.toLowerCase()
    return needles.some((needle) => lowerKey.includes(needle)) && value
  })

  return entry?.[1] ? String(entry[1]) : null
}

function pickNumber(record: FlatRecord, needles: string[]) {
  const value = pickString(record, needles)
  if (!value) {
    return null
  }

  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function normalizeTimestamp(value: string | null) {
  if (!value) {
    return null
  }

  const asNumber = Number(value)
  const date = Number.isFinite(asNumber) && value.length >= 10
    ? new Date(value.length > 10 ? asNumber : asNumber * 1000)
    : new Date(value)

  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function toEvent(path: string, category: DataCategory, record: FlatRecord, index: number) {
  const contact =
    pickString(record, ['friend', 'contact', 'username', 'participant', 'recipient']) ??
    null
  const text = pickString(record, ['message', 'chat', 'content', 'body', 'text'])
  const detail =
    pickString(record, ['query', 'search', 'status', 'action', 'type', 'filename']) ?? null

  const event: NormalizedEvent = {
    id: `${slugify(path)}-${index}`,
    category,
    sourceFile: path,
    timestamp: normalizeTimestamp(
      pickString(record, ['timestamp', 'created', 'date', 'time', 'sent', 'saved']),
    ),
    contact,
    text,
    detail,
    locationName: pickString(record, ['location', 'place', 'city', 'address']),
    latitude: pickNumber(record, ['lat']),
    longitude: pickNumber(record, ['lon', 'lng']),
    device: pickString(record, ['device', 'model', 'platform']),
    region: pickString(record, ['region', 'country', 'ip']),
  }

  return event
}

function normalizeEvents(path: string, category: DataCategory, records: FlatRecord[]) {
  return records
    .map((record, index) => toEvent(path, category, record, index))
    .filter((event) => {
      if (category === 'unknown') {
        return Boolean(event.timestamp || event.contact || event.text || event.detail)
      }

      return true
    })
}

export async function parseSnapchatZip(file: File): Promise<ParsedDataset> {
  const zip = await JSZip.loadAsync(file)
  const events: NormalizedEvent[] = []
  const fileSummaries: FileSummary[] = []

  const entries = Object.values(zip.files).filter(
    (entry) => !entry.dir && hasSupportedExtension(entry.name),
  )

  await Promise.all(
    entries.map(async (entry) => {
      const content = await entry.async('text')
      const category = detectCategory(entry.name)
      const records = parseByExtension(entry.name, content)
      const normalized = normalizeEvents(entry.name, category, records)

      events.push(...normalized)
      fileSummaries.push({
        path: entry.name,
        category,
        rows: normalized.length,
      })
    }),
  )

  const dataset = buildDataset(
    events
      .sort((left, right) => {
        if (!left.timestamp) {
          return 1
        }

        if (!right.timestamp) {
          return -1
        }

        return left.timestamp.localeCompare(right.timestamp)
      })
      .slice(-3000),
  )

  return {
    ...dataset,
    fileSummaries: fileSummaries.sort((left, right) => right.rows - left.rows),
  }
}
