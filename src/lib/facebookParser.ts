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
type ParseProgress = {
  percent: number
  label: string
}
type ParseProgressHandler = (progress: ParseProgress) => void

const SUPPORTED_EXTENSIONS = ['.json', '.csv', '.html', '.htm', '.txt']
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
const NOISE_TERMS = new Set([
  'facebook',
  'download your information',
  'activity log',
  'meta',
])

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

function normalizeText(value: string | null | undefined) {
  return (value ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function sanitizeReadableText(value: string | null | undefined) {
  const normalized = normalizeText(value)
  if (!normalized) return null
  if (NOISE_TERMS.has(normalized.toLowerCase())) return null
  return normalized
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

function normalizeTimestamp(value: string | number | null | undefined) {
  if (value === null || value === undefined) return null

  if (typeof value === 'number') {
    const date = new Date(String(value).length >= 13 ? value : value * 1000)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }

  const trimmed = value.trim()
  if (!trimmed) return null
  const numeric = Number(trimmed)
  if (Number.isFinite(numeric)) {
    const date = new Date(trimmed.length >= 13 ? numeric : numeric * 1000)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }

  const date = new Date(trimmed)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function pickString(record: FlatRecord, needles: string[]) {
  const entry = Object.entries(record).find(([key, value]) => {
    if (value === null || value === '') return false
    const lower = key.toLowerCase()
    return needles.some((needle) => lower.includes(needle))
  })

  return entry?.[1] !== undefined && entry[1] !== null ? String(entry[1]) : null
}

function pickNumber(record: FlatRecord, needles: string[]) {
  const value = pickString(record, needles)
  if (!value) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function deriveFacebookCategory(path: string): DataCategory {
  const lower = path.toLowerCase().replace(/\\/g, '/')
  if (lower.includes('messages/inbox') || lower.includes('messages/message_requests')) return 'chat'
  if (lower.includes('profile_information') || lower.includes('personal_information')) return 'account'
  if (lower.includes('friends') || lower.includes('followers') || lower.includes('following')) return 'friend'
  if (lower.includes('search_history')) return 'search'
  if (lower.includes('security_and_login_information') || lower.includes('logins') || lower.includes('used_ip')) return 'login'
  if (lower.includes('location_history') || lower.includes('check_ins') || lower.includes('places')) return 'location'
  if (lower.includes('photos_and_videos') || lower.includes('stories') || lower.includes('archive')) return 'memory'
  if (lower.includes('likes_and_reactions')) return 'reaction'
  if (lower.includes('comments') || lower.includes('posts') || lower.includes('your_posts')) return 'post'
  if (lower.includes('groups')) return 'group'
  if (lower.includes('pages')) return 'page'
  if (lower.includes('events')) return 'event'
  return 'unknown'
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
  next.username = next.username ?? pickString(record, ['username', 'vanity', 'profile_uri']) ?? null
  next.displayName = next.displayName ?? pickString(record, ['name', 'full_name', 'display']) ?? null
  next.email = next.email ?? pickString(record, ['email']) ?? null
  next.phone = next.phone ?? pickString(record, ['phone', 'mobile']) ?? null
  next.region = next.region ?? pickString(record, ['city', 'region', 'current_city', 'locale']) ?? null

  ;[next.username, next.displayName, next.email, next.phone]
    .filter((value): value is string => Boolean(value))
    .forEach((value) => {
      if (!next.aliases.includes(value)) {
        next.aliases.push(value)
      }
    })

  return next
}

function parseCsv(content: string) {
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

function parseJson(content: string) {
  try {
    return JSON.parse(content) as unknown
  } catch {
    return null
  }
}

function parseHtml(content: string) {
  const document = new DOMParser().parseFromString(content, 'text/html')
  const bodyText = document.body?.innerText ?? document.body?.textContent ?? ''
  const rows = [...document.querySelectorAll('table tr')]
  const tableRecords = rows.length > 1
    ? rows.slice(1).map((row, index) => ({
        row: index + 1,
        line: sanitizeReadableText(
          [...row.querySelectorAll('th,td')]
            .map((cell) => cell.textContent ?? '')
            .join(' | '),
        ),
      }))
    : []

  if (tableRecords.length) {
    return tableRecords.filter((record) => record.line)
  }

  return bodyText
    .split(/\r?\n/)
    .map((line, index) => ({
      row: index + 1,
      line: sanitizeReadableText(line),
    }))
    .filter((record) => record.line)
}

function parseTxt(content: string) {
  return content
    .split(/\r?\n/)
    .map((line, index) => ({
      row: index + 1,
      line: sanitizeReadableText(line),
    }))
    .filter((record) => record.line)
}

function messageDetailFromRecord(record: Record<string, unknown>) {
  if (Array.isArray(record.photos) && record.photos.length) return `${record.photos.length} photo attachment(s)`
  if (Array.isArray(record.videos) && record.videos.length) return `${record.videos.length} video attachment(s)`
  if (Array.isArray(record.audio_files) && record.audio_files.length) return `${record.audio_files.length} audio attachment(s)`
  if (Array.isArray(record.gifs) && record.gifs.length) return `${record.gifs.length} gif attachment(s)`
  if (record.share && typeof record.share === 'object') {
    const share = record.share as Record<string, unknown>
    const shareText = sanitizeReadableText(String(share.link ?? share.share_text ?? ''))
    return shareText ?? 'shared content'
  }
  return null
}

function buildMessageContact(
  title: string | null,
  participants: string[],
) {
  if (title && title.trim()) return title.trim()

  const uniqueParticipants = [...new Set(participants.filter((name) => name && name.trim()))]
  if (uniqueParticipants.length === 1) return uniqueParticipants[0]
  if (uniqueParticipants.length > 1) return uniqueParticipants.sort((left, right) => left.localeCompare(right)).join(' & ')
  return 'Messenger thread'
}

function parseFacebookMessages(
  uploadId: string,
  path: string,
  payload: Record<string, unknown>,
): NormalizedEvent[] {
  const rawMessages = Array.isArray(payload.messages) ? payload.messages : []
  const participants = Array.isArray(payload.participants)
    ? payload.participants
        .map((entry) => (entry && typeof entry === 'object' ? sanitizeReadableText(String((entry as Record<string, unknown>).name ?? '')) : null))
        .filter((value): value is string => Boolean(value))
    : []
  const title = sanitizeReadableText(typeof payload.title === 'string' ? payload.title : null)
  const events: NormalizedEvent[] = []

  rawMessages.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return

    const message = entry as Record<string, unknown>
    const senderName = sanitizeReadableText(typeof message.sender_name === 'string' ? message.sender_name : null)
    const text = sanitizeReadableText(typeof message.content === 'string' ? message.content : null)
    const detail = messageDetailFromRecord(message)
    if (!text && !detail) return

    const contact = buildMessageContact(title, participants)
    const subtype = Array.isArray(message.reactions) && message.reactions.length ? 'message with reactions' : 'message'

    events.push({
      id: `${uploadId}:${slugify(path)}:message:${index}`,
      uploadId,
      category: 'chat',
      subtype,
      sourceFile: path,
      timestamp: normalizeTimestamp((message.timestamp_ms as number | undefined) ?? null),
      contact,
      text,
      detail,
      locationName: null,
      latitude: null,
      longitude: null,
      device: null,
      region: null,
      evidenceText: sanitizeReadableText([senderName, text, detail].filter(Boolean).join(' ')) ?? '',
      attributes: {
        sender_name: senderName,
        thread_title: title,
        participants: participants.join(' | '),
        timestamp_ms: typeof message.timestamp_ms === 'number' ? message.timestamp_ms : null,
      },
    })
  })

  return events
}

function deriveGenericContact(record: FlatRecord, path: string) {
  const direct = sanitizeReadableText(
    pickString(record, [
      'contact',
      'sender_name',
      'author',
      'friend',
      'name',
      'participant',
      'actor',
      'title',
      'group_name',
      'page_name',
    ]),
  )

  if (direct) return direct

  const stem = baseName(path)
    .replace(/[_-]+/g, ' ')
    .replace(/\d+$/g, '')
    .trim()

  return sanitizeReadableText(stem)
}

function deriveGenericText(record: FlatRecord) {
  const direct = sanitizeReadableText(
    pickString(record, [
      'content',
      'message',
      'comment',
      'title',
      'description',
      'post',
      'reaction',
      'name',
      'line',
      'value',
    ]),
  )

  if (direct) return direct

  const fallback = Object.values(record)
    .filter((value): value is string => typeof value === 'string')
    .map((value) => sanitizeReadableText(value))
    .filter((value): value is string => Boolean(value))
    .find((value) => value.length > 8)

  return fallback ?? null
}

function normalizeGenericEvent(
  uploadId: string,
  path: string,
  category: DataCategory,
  record: FlatRecord,
  index: number,
) {
  const text = deriveGenericText(record)
  const detail = sanitizeReadableText(
    pickString(record, ['uri', 'href', 'address', 'city', 'device', 'reaction', 'attachment']),
  )

  return {
    id: `${uploadId}:${slugify(path)}:${index}`,
    uploadId,
    category,
    subtype: sanitizeReadableText(pickString(record, ['type', 'action', 'event', 'status'])),
    sourceFile: path,
    timestamp: normalizeTimestamp(
      pickString(record, ['timestamp_ms', 'timestamp', 'creation_timestamp', 'created', 'time', 'date']),
    ),
    contact: deriveGenericContact(record, path),
    text,
    detail,
    locationName: sanitizeReadableText(pickString(record, ['location', 'place', 'city', 'address'])),
    latitude: pickNumber(record, ['latitude', 'lat']),
    longitude: pickNumber(record, ['longitude', 'lng', 'lon']),
    device: sanitizeReadableText(pickString(record, ['device', 'platform', 'user_agent'])),
    region: sanitizeReadableText(pickString(record, ['region', 'country', 'state', 'city', 'ip_address'])),
    evidenceText: sanitizeReadableText(
      Object.values(record)
        .filter((value) => typeof value === 'string' || typeof value === 'number')
        .slice(0, 10)
        .join(' '),
    ) ?? '',
    attributes: record,
  } satisfies NormalizedEvent
}

function collectFlatRecords(value: unknown): FlatRecord[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectFlatRecords(item))
  }

  if (!value || typeof value !== 'object') {
    return []
  }

  const object = value as Record<string, unknown>
  if (Object.keys(object).length === 0) return []
  return [flattenObject(object)]
}

function parseFacebookContent(uploadId: string, path: string, content: string) {
  const extension = extensionOf(path)
  const category = deriveFacebookCategory(path)

  if (extension === '.json') {
    const payload = parseJson(content)
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const recordPayload = payload as Record<string, unknown>
      if (category === 'chat' && Array.isArray(recordPayload.messages)) {
        return {
          category,
          records: [] as FlatRecord[],
          events: parseFacebookMessages(uploadId, path, recordPayload),
          accountRows: [],
        }
      }
    }

    const records = collectFlatRecords(payload)
    return {
      category,
      records,
      events: records.map((record, index) => normalizeGenericEvent(uploadId, path, category, record, index)),
      accountRows: category === 'account' ? records : [],
    }
  }

  if (extension === '.csv') {
    const records = parseCsv(content)
    return {
      category,
      records,
      events: records.map((record, index) => normalizeGenericEvent(uploadId, path, category, record, index)),
      accountRows: category === 'account' ? records : [],
    }
  }

  const records = extension === '.html' || extension === '.htm' ? parseHtml(content) : parseTxt(content)
  return {
    category,
    records,
    events: records.map((record, index) => normalizeGenericEvent(uploadId, path, category, record, index)),
    accountRows: category === 'account' ? records : [],
  }
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

export async function parseFacebookZip(
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
    label: `Opened Facebook export with ${supportedEntries.length} supported files.`,
  })

  for (const entry of supportedEntries) {
    try {
      const content = await entry.async('text', (metadata) => {
        onProgress?.({
          percent: Math.min(95, ((completedSteps + metadata.percent / 100) / totalSteps) * 100),
          label: `Parsing ${entry.name} (${Math.round(metadata.percent)}%)`,
        })
      })
      const parsed = parseFacebookContent(uploadId, entry.name, content)
      parsed.accountRows.forEach((record) => {
        account = enrichAccount(account, record)
      })
      events.push(...parsed.events.filter((event) => Boolean(event.timestamp || event.contact || event.text || event.detail)))
      fileSummaries.push({
        uploadId,
        path: entry.name,
        extension: extensionOf(entry.name),
        category: parsed.category,
        rows: parsed.events.length,
        supported: true,
      })
    } catch (error) {
      warnings.push(
        `Could not parse ${entry.name}: ${error instanceof Error ? error.message : 'unknown error'}`,
      )
    } finally {
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
    label: `Facebook zip parse finished with ${events.length} normalized rows. Building thread index...`,
  })

  return {
    upload,
    fileSummaries: fileSummaries.sort((left, right) => right.rows - left.rows),
    events: events.sort((left, right) => {
      if (!left.timestamp) return 1
      if (!right.timestamp) return -1
      return left.timestamp.localeCompare(right.timestamp)
    }),
  }
}

export async function parseFacebookFileList(
  files: File[],
  onProgress?: ParseProgressHandler,
): Promise<ParsedUpload> {
  const uploadId = slugify(`facebook-folder-${files[0]?.name ?? 'export'}-${Date.now()}`)
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
      const parsed = parseFacebookContent(uploadId, path, content)
      parsed.accountRows.forEach((record) => {
        account = enrichAccount(account, record)
      })
      events.push(...parsed.events.filter((event) => Boolean(event.timestamp || event.contact || event.text || event.detail)))
      fileSummaries.push({
        uploadId,
        path,
        extension: extensionOf(path),
        category: parsed.category,
        rows: parsed.events.length,
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
    label: `Facebook folder parse finished with ${events.length} normalized rows. Building thread index...`,
  })

  return {
    upload: {
      id: uploadId,
      fileName: files[0]?.webkitRelativePath?.split('/')[0] || 'facebook-export',
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
      if (!left.timestamp) return 1
      if (!right.timestamp) return -1
      return left.timestamp.localeCompare(right.timestamp)
    }),
  }
}
