import {
  startTransition,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react'
import './App.css'
import { FacebookConversationList } from './components/FacebookConversationList'
import type {
  AIProvider,
  AIResult,
  AISettings,
  ContactSummary,
  FileSummary,
  NormalizedEvent,
  ParsedUpload,
  Platform,
  UploadSummary,
  WorkspaceDataset,
} from './types'
import { runAIReview, runContactAIReview } from './lib/ai'
import { splitFacebookTranscriptBlocks } from './lib/facebookTranscript'
import {
  downloadContactsCsv,
  downloadEventsJson,
  downloadHtml,
  downloadKeywordHitsCsv,
  downloadPlainText,
  downloadReviewContactsCsv,
  downloadWorkspaceReport,
} from './lib/exporters'
import { buildWorkspaceLite } from './lib/insights'
import { clearSnapshot, loadSnapshot, saveSnapshot } from './lib/persistence'
import { parseFacebookFileList, parseFacebookZip } from './lib/facebookParser'
import { parseSnapchatFileList, parseSnapchatZip } from './lib/snapchatParser'
import { sampleFacebookUpload, sampleSnapchatUpload } from './sampleData'

type ContactLabel = 'male' | 'female' | 'unknown'
type ActiveTab = 'overview' | 'chats' | 'search' | 'signals' | 'ai' | 'data'
type ContactSort = 'activity' | 'messages' | 'romance' | 'secrecy' | 'recent' | 'missing'
type ThreadMode = 'chat' | 'all'
type ThreadSort = 'newest' | 'oldest'
type MetricKey = 'contacts' | 'threads' | 'missing' | 'deletions' | 'timing' | 'files'

type ModalState =
  | { type: 'contact'; contactName: string }
  | { type: 'thread-focus'; contactName: string }
  | { type: 'event'; eventId: string }
  | { type: 'signal'; signalId: string }
  | { type: 'upload'; uploadId: string }
  | { type: 'file'; uploadId: string; path: string }
  | { type: 'timeline'; dayKey: string }
  | { type: 'metric'; key: MetricKey }
  | null

const NOTES_KEY = 'export-viewer-pro-private-notes'
const AI_SETTINGS_KEY = 'export-viewer-pro-ai-settings'
const CONTACT_LABELS_KEY = 'export-viewer-pro-contact-labels'
const REVIEW_LATER_KEY = 'export-viewer-pro-review-later'
const LOCK_CODE_KEY = 'export-viewer-pro-lock-code'
const LAST_PLATFORM_KEY = 'export-viewer-pro-last-platform'
const DEFAULT_MODELS: Record<AIProvider, string> = {
  gemini: 'gemini-2.5-pro',
  openai: 'gpt-5.1',
}
const MODEL_PRESETS: Record<AIProvider, string[]> = {
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  openai: ['gpt-5.1', 'gpt-5-mini'],
}
const PLATFORM_CONFIG: Record<
  Platform,
  {
    label: string
    heroTitle: string
    heroCopy: string
    pickerCopy: string
    folderStatus: string
    supportedAreas: string[]
    sampleUpload: ParsedUpload
    parseZip: typeof parseSnapchatZip
    parseFolder: typeof parseSnapchatFileList
  }
> = {
  snapchat: {
    label: 'Snapchat',
    heroTitle: 'Snapchat Viewer',
    heroCopy:
      'Snapchat export review with click-through threads, timing analysis, and per-contact AI organization.',
    pickerCopy: 'Saved chats, search history, login/device history, location, memories, and related export data.',
    folderStatus: 'Parsing extracted Snapchat export folder and skipping media...',
    supportedAreas: [
      'Account',
      'Saved chats',
      'Snap history',
      'Friends',
      'Search',
      'Location',
      'Login/device',
      'Memories',
      'Bitmoji',
      'Support',
      'Purchase',
    ],
    sampleUpload: sampleSnapchatUpload,
    parseZip: parseSnapchatZip,
    parseFolder: parseSnapchatFileList,
  },
  facebook: {
    label: 'Facebook',
    heroTitle: 'Facebook Viewer',
    heroCopy:
      'Facebook data export and activity-log review with Messenger threads, profile activity, searches, security events, posts, reactions, groups, and events.',
    pickerCopy:
      'Messages, friends, search history, security/login, comments, reactions, groups, events, location, and profile data.',
    folderStatus: 'Parsing extracted Facebook export folder and skipping media...',
    supportedAreas: [
      'Profile information',
      'Messenger inbox',
      'Friends and followers',
      'Search history',
      'Security/login',
      'Comments',
      'Likes and reactions',
      'Posts',
      'Groups',
      'Events',
      'Location history',
      'Photos and videos',
    ],
    sampleUpload: sampleFacebookUpload,
    parseZip: parseFacebookZip,
    parseFolder: parseFacebookFileList,
  },
}
const DELETION_TERMS = [
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
]
const TAB_LABELS: Array<{ id: ActiveTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'chats', label: 'Chats' },
  { id: 'search', label: 'Search' },
  { id: 'signals', label: 'Signals' },
  { id: 'ai', label: 'AI' },
  { id: 'data', label: 'Data' },
]
const MEDIA_DETAIL_PATTERN = /\.(?:jpe?g|png|gif|heic|mp4|mov|webm|avi|mkv)$/i
const THREAD_PAGE_SIZE = 200
const LARGE_EXPORT_THRESHOLD = 4000
const CONTACT_AI_QUESTION =
  'Organize this selected thread into a factual timeline, interaction patterns, flirt and secrecy cues, repeated names or references, media sent by each side, and open follow-up checks with evidence IDs.'

function scopedStorageKey(base: string, platform: Platform) {
  return `${base}-${platform}`
}

function estimateTokenCount(events: NormalizedEvent[]) {
  const joined = events
    .map((event) => [event.timestamp, event.contact, event.text ?? event.detail ?? event.evidenceText].filter(Boolean).join(' '))
    .join('\n')

  return Math.max(0, Math.ceil(joined.length / 4))
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, value))
}

function yearFromTimestamp(value: string | null) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.getUTCFullYear()
}

function yearLabel(value: number | 'all' | null) {
  return value === null || value === 'all' ? 'All years' : String(value)
}

function uniqueYears(events: NormalizedEvent[]) {
  return [...new Set(events.map((event) => yearFromTimestamp(event.timestamp)).filter((value): value is number => value !== null))].sort(
    (left, right) => right - left,
  )
}

function isParsedUploadLike(value: unknown): value is ParsedUpload {
  if (!value || typeof value !== 'object') return false
  const candidate = value as ParsedUpload
  return Boolean(candidate.upload && Array.isArray(candidate.fileSummaries) && Array.isArray(candidate.events))
}

type ContactDateMarker = {
  label: string
  event: NormalizedEvent
}

type ConversationRole = 'self' | 'contact' | 'system'
type TranscriptBlock = {
  timestamp: string | null
  actor: string | null
  text: string
}

function formatDate(value: string | null) {
  if (!value) return 'Unknown'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString()
}

function formatDay(value: string | null) {
  if (!value) return 'Unknown'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? 'Unknown'
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function formatThreadDay(value: string | null) {
  if (!value) return 'Unknown day'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? 'Unknown day'
    : date.toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
}

function formatThreadTimestamp(value: string | null) {
  if (!value) return 'Unknown time'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? 'Unknown time'
    : date.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}

function compact(value: string | null | undefined) {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

function preserveBodyText(value: string | null | undefined) {
  if (!value) return ''
  return value
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function formatPlainConversationText(value: string | null | undefined) {
  if (!value) return ''

  const decoded = new DOMParser().parseFromString(value, 'text/html').documentElement.textContent ?? value
  const normalized = value
    .replace(/<[^>]+>/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const plain = decoded
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  if (!plain) return ''

  const looksStructured =
    (/^[[{]/.test(normalized) && /[:",]/.test(normalized)) ||
    /"[\w.-]+"\s*:/.test(normalized) ||
    /\b(function|const|let|var|return|document\.|window\.|querySelector|className|style=|svg|div|span|button)\b/.test(normalized) ||
    /<\/?[a-z][^>]*>/i.test(decoded) ||
    /[<>]{2,}/.test(decoded)

  if (looksStructured) {
    return ''
  }

  if (/^\s*<\/?[a-z][^>]*>/i.test(decoded) || /class=|style=|xmlns=|svg|path d=|button class=/i.test(decoded)) {
    return ''
  }

  return preserveBodyText(plain)
}

const THREAD_TIMESTAMP_PATTERN =
  /\b(?:[A-Z][a-z]{2,8} \d{1,2}, \d{4} \d{1,2}:\d{2}:\d{2} ?(?:am|pm)|\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC)\b/g

function separateCamelCaseWords(value: string) {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]{2,})([A-Z][a-z])/g, '$1 $2')
}

function splitReadableTranscript(value: string | null | undefined) {
  const plain = formatPlainConversationText(value)
  if (!plain) {
    return []
  }

  const matches = [...plain.matchAll(THREAD_TIMESTAMP_PATTERN)]
  if (matches.length <= 1) {
    const { actor, text } = extractTranscriptActor(plain)
    return [{ timestamp: null, actor, text }]
  }

  const blocks: TranscriptBlock[] = []

  matches.forEach((match, index) => {
    const timestamp = match[0]?.trim() ?? null
    const start = (match.index ?? 0) + (match[0]?.length ?? 0)
    const end = matches[index + 1]?.index ?? plain.length
    const segment = plain.slice(start, end).replace(/^[,:;\s"'`]+/, '').trim()
    if (!segment) {
      return
    }

    const { actor, text } = extractTranscriptActor(segment)
    blocks.push({
      timestamp,
      actor,
      text: text || segment,
    })
  })

  return blocks
}

function renderTranscriptBlocks(value: string | null | undefined, terms: string[]) {
  const blocks = splitReadableTranscript(value)
  if (!blocks.length) {
    return null
  }

  return blocks.map((block, index) => (
    <div className="transcript-block" key={`${block.timestamp ?? 'block'}-${index}`}>
      {block.timestamp ? <span className="transcript-timestamp">{block.timestamp}</span> : null}
      {block.actor ? <strong className="transcript-actor">{block.actor}</strong> : null}
      <div className="transcript-body">
        <HighlightedText terms={terms} text={block.text} />
      </div>
    </div>
  ))
}

function extractTranscriptActor(text: string) {
  const cleaned = separateCamelCaseWords(text.replace(/^[\s,:;'"`â¤ï¸Ž€¢-]+/, ''))
  const openMatch = cleaned.match(
    /^([A-Z][A-Za-z0-9'._-]+(?:\s+[A-Z][A-Za-z0-9'._-]+){1,3})(?:\s+|)(.*)$/,
  )

  if (!openMatch) {
    return { actor: null, text: cleaned }
  }

  const actor = openMatch[1].trim()
  const body = compact(openMatch[2])
  if (!body) {
    return { actor: null, text: cleaned }
  }

  return { actor, text: body }
}

function sortThreadEvents(events: NormalizedEvent[], sortOrder: ThreadSort) {
  return [...events].sort((left, right) => {
    const leftTime = left.timestamp ?? ''
    const rightTime = right.timestamp ?? ''

    if (leftTime && rightTime) {
      return sortOrder === 'newest'
        ? rightTime.localeCompare(leftTime)
        : leftTime.localeCompare(rightTime)
    }

    if (leftTime) {
      return sortOrder === 'newest' ? -1 : 1
    }

    if (rightTime) {
      return sortOrder === 'newest' ? 1 : -1
    }

    return left.id.localeCompare(right.id)
  })
}

function buildReadableTranscript(
  events: NormalizedEvent[],
  aliasIndex: Map<string, Set<string>>,
  platform: Platform,
) {
  return events
    .map((event) => {
      const role = resolveConversationRole(event, aliasIndex)
      const actor = extractActorValue(event) ?? (role === 'self' ? 'You' : event.contact ?? 'Unknown')
      const header = `${formatThreadTimestamp(event.timestamp)} — ${actor} [${event.category}]`
      const raw = eventConversationText(event) || eventSummaryText(event)
      const facebookBlocks = platform === 'facebook' ? splitFacebookTranscriptBlocks(raw) : []
      const blocks = facebookBlocks.length ? facebookBlocks : splitReadableTranscript(raw)

      if (!blocks.length) {
        const body = eventSummaryText(event)
        return [header, body, `Source: ${event.sourceFile}`, ''].join('\n')
      }

      const blockText = blocks
        .map((block) => {
          const lines = [
            block.timestamp ? `  ${block.timestamp}` : null,
            block.actor ? `  ${block.actor}` : null,
            `  ${block.text}`,
          ].filter(Boolean)
          return lines.join('\n')
        })
        .join('\n')

      return [header, blockText, `Source: ${event.sourceFile}`, ''].join('\n')
    })
    .join('\n')
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function buildChatExportHtml(
  title: string,
  events: NormalizedEvent[],
  aliasIndex: Map<string, Set<string>>,
  platform: Platform,
) {
  const start = events[0]?.timestamp ? formatDate(events[0].timestamp) : 'Unknown'
  const end = events[events.length - 1]?.timestamp ? formatDate(events[events.length - 1].timestamp) : 'Unknown'
  const cards = events
    .map((event) => {
      const role = resolveConversationRole(event, aliasIndex)
      const actor = extractActorValue(event) ?? (role === 'self' ? 'You' : event.contact ?? 'Unknown')
      const timestamp = formatThreadTimestamp(event.timestamp)
      const raw = eventConversationText(event) || eventSummaryText(event)
      const blocks =
        platform === 'facebook'
          ? splitFacebookTranscriptBlocks(raw)
          : splitReadableTranscript(raw)
      const body =
        blocks.length > 0
          ? blocks
              .map(
                (block) => `
                  <section class="chat-turn role-${role}">
                    <div class="chat-turn-head">
                      ${block.timestamp ? `<span class="chat-turn-time">${escapeHtml(block.timestamp)}</span>` : ''}
                      ${block.actor ? `<strong class="chat-turn-actor">${escapeHtml(block.actor)}</strong>` : ''}
                    </div>
                    <div class="chat-turn-body">${escapeHtml(block.text).replace(/\n/g, '<br />')}</div>
                  </section>
                `,
              )
              .join('')
          : `
            <div class="chat-turn role-${role}">
              <div class="chat-turn-body">${escapeHtml(raw || 'No readable chat text was recovered.').replace(/\n/g, '<br />')}</div>
            </div>
          `

      return `
        <article class="chat-card role-${role}">
          <div class="chat-card-head">
            <strong>${escapeHtml(actor)}</strong>
            <span>${escapeHtml(timestamp)}${event.category ? ` · ${escapeHtml(event.category)}` : ''}</span>
          </div>
          ${body}
        </article>
      `
    })
    .join('')

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)} - chat export</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: Inter, Segoe UI, Arial, sans-serif;
        background: #070b12;
        color: #edf4ff;
      }
      .page {
        max-width: 980px;
        margin: 0 auto;
        padding: 24px;
      }
      .hero {
        display: grid;
        gap: 8px;
        margin-bottom: 18px;
      }
      .hero h1 {
        margin: 0;
        font-size: 28px;
      }
      .hero p {
        margin: 0;
        color: #97adc7;
      }
      .chat-list {
        display: grid;
        gap: 12px;
      }
      .chat-card {
        display: grid;
        gap: 10px;
        padding: 14px 16px;
        border-radius: 18px;
        border: 1px solid rgba(138, 182, 255, 0.18);
        background: linear-gradient(180deg, rgba(13, 19, 31, 0.96), rgba(8, 14, 24, 0.96));
        box-shadow: 0 18px 32px rgba(0, 0, 0, 0.24);
      }
      .chat-card.role-self {
        background: linear-gradient(180deg, rgba(28, 83, 217, 0.95), rgba(18, 54, 150, 0.94));
        border-color: rgba(138, 182, 255, 0.34);
      }
      .chat-card-head {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: center;
        font-size: 14px;
        color: #d0dcf0;
      }
      .chat-card-head strong {
        font-size: 15px;
        color: inherit;
      }
      .chat-card-head span {
        color: #9ab2cf;
        text-align: right;
      }
      .chat-turn {
        display: grid;
        gap: 8px;
        padding: 12px 14px;
        border-radius: 16px;
        border: 1px solid rgba(138, 182, 255, 0.16);
        background: rgba(6, 10, 18, 0.88);
      }
      .chat-turn.role-self {
        background: rgba(255, 255, 255, 0.12);
      }
      .chat-turn-head {
        display: grid;
        gap: 4px;
      }
      .chat-turn-time {
        font-size: 12px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: #a8c6ff;
      }
      .chat-turn-actor {
        font-size: 14px;
        color: #eff5ff;
      }
      .chat-turn-body {
        white-space: pre-wrap;
        line-height: 1.65;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      @media print {
        body { background: #fff; color: #111; }
        .page { max-width: none; padding: 0; }
        .chat-card, .chat-turn { break-inside: avoid; page-break-inside: avoid; }
      }
      @media (max-width: 720px) {
        .page { padding: 14px; }
        .chat-card-head { flex-direction: column; align-items: flex-start; }
        .chat-card-head span { text-align: left; }
      }
    </style>
  </head>
  <body>
    <main class="page">
      <header class="hero">
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(start)} to ${escapeHtml(end)} · ${events.length} visible row(s)</p>
      </header>
      <section class="chat-list">
        ${cards || '<p>No readable chat text was recovered for this export.</p>'}
      </section>
    </main>
  </body>
</html>`
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function queryTermsFromInput(value: string) {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
}

function peakHourLabel(events: Array<{ hour: number; count: number }>) {
  const top = [...events].sort((left, right) => right.count - left.count)[0]
  return top?.count ? `${top.hour.toString().padStart(2, '0')}:00` : 'Unknown'
}

function peakWeekdayLabel(events: Array<{ label: string; count: number }>) {
  const top = [...events].sort((left, right) => right.count - left.count)[0]
  return top?.count ? top.label : 'Unknown'
}

function hasDeletionIndicator(event: NormalizedEvent) {
  const haystack = compact(
    [event.text, event.detail, event.subtype, event.evidenceText, event.sourceFile]
      .filter(Boolean)
      .join(' '),
  ).toLowerCase()

  return DELETION_TERMS.some((term) => haystack.includes(term))
}

function isMediaEvent(event: NormalizedEvent) {
  const haystack = compact(
    [event.text, event.detail, event.subtype, event.evidenceText, event.sourceFile]
      .filter(Boolean)
      .join(' '),
  )

  return (
    event.category === 'memory' ||
    MEDIA_DETAIL_PATTERN.test(haystack) ||
    /\b(photo|video|media|image|snap)\b/i.test(haystack)
  )
}

function eventSummaryText(event: NormalizedEvent) {
  const candidates = [event.text, event.detail, event.evidenceText]
  for (const candidate of candidates) {
    const plain = formatPlainConversationText(candidate)
    if (plain) {
      return plain
    }
  }

  const detailLines = [event.detail, event.locationName, event.device, event.region]
    .map((value) => preserveBodyText(value))
    .filter(Boolean)

  if (detailLines.length) {
    return detailLines.join('\n')
  }

  return preserveBodyText(event.evidenceText) || 'No visible text for this row.'
}

function eventConversationText(event: NormalizedEvent) {
  return formatPlainConversationText(event.text ?? event.detail ?? event.evidenceText)
}

function sortedDatedEvents(events: NormalizedEvent[]) {
  return [...events]
    .filter((event) => Boolean(event.timestamp))
    .sort((left, right) => (left.timestamp && right.timestamp ? left.timestamp.localeCompare(right.timestamp) : 0))
}

function buildDateMarkers(events: NormalizedEvent[]) {
  const dated = sortedDatedEvents(events)
  const definitions: Array<{
    firstLabel: string
    lastLabel: string
    predicate: (event: NormalizedEvent) => boolean
  }> = [
    {
      firstLabel: 'First activity',
      lastLabel: 'Last activity',
      predicate: () => true,
    },
    {
      firstLabel: 'First message',
      lastLabel: 'Last message',
      predicate: (event) => event.category === 'chat',
    },
    {
      firstLabel: 'First search',
      lastLabel: 'Last search',
      predicate: (event) => event.category === 'search',
    },
    {
      firstLabel: 'First friend row',
      lastLabel: 'Last friend row',
      predicate: (event) => event.category === 'friend',
    },
    {
      firstLabel: 'First photo/video row',
      lastLabel: 'Last photo/video row',
      predicate: (event) => isMediaEvent(event),
    },
  ]

  return definitions.flatMap(({ firstLabel, lastLabel, predicate }) => {
    const matches = dated.filter(predicate)
    if (!matches.length) {
      return []
    }

    const markers: ContactDateMarker[] = [{ label: firstLabel, event: matches[0] }]
    if (matches.length > 1) {
      markers.push({ label: lastLabel, event: matches[matches.length - 1] })
    } else {
      markers.push({ label: lastLabel, event: matches[0] })
    }
    return markers
  })
}

function buildTimelineBuckets(events: NormalizedEvent[]) {
  const buckets = new Map<
    string,
    {
      key: string
      label: string
      count: number
      categories: Partial<Record<string, number>>
      evidenceIds: string[]
    }
  >()

  events.forEach((event) => {
    if (!event.timestamp) {
      return
    }

    const key = event.timestamp.slice(0, 10)
    const current =
      buckets.get(key) ?? {
        key,
        label: formatThreadDay(event.timestamp),
        count: 0,
        categories: {},
        evidenceIds: [],
      }

    current.count += 1
    current.categories[event.category] = (current.categories[event.category] ?? 0) + 1
    if (!current.evidenceIds.includes(event.id)) {
      current.evidenceIds.push(event.id)
    }
    buckets.set(key, current)
  })

  return [...buckets.values()].sort((left, right) => left.key.localeCompare(right.key))
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

function normalizeAlias(value: string) {
  return value.toLowerCase().trim()
}

function buildAliasIndex(uploads: UploadSummary[]) {
  return new Map(
    uploads.map((upload) => {
      const values = [
        upload.account.username,
        upload.account.displayName,
        upload.account.email,
        upload.account.phone,
        ...upload.account.aliases,
      ]
        .filter((value): value is string => Boolean(value))
        .map((value) => normalizeAlias(value))

      return [upload.id, new Set(values)] as const
    }),
  )
}

function resolveConversationRole(event: NormalizedEvent, aliasIndex: Map<string, Set<string>>): ConversationRole {
  if (event.category !== 'chat') {
    return 'system'
  }

  const actor = extractActorValue(event)
  if (!actor) {
    return 'contact'
  }

  const aliases = aliasIndex.get(event.uploadId)
  return aliases?.has(normalizeAlias(actor)) ? 'self' : 'contact'
}

function ConversationList(props: {
  aliasIndex: Map<string, Set<string>>
  events: NormalizedEvent[]
  onEventClick: (eventId: string) => void
  terms: string[]
  plainTextOnly?: boolean
  sortOrder: ThreadSort
}) {
  const events = sortThreadEvents(props.events, props.sortOrder)

  return (
    <div className="conversation-list">
      {events.map((event, index) => {
        const dayKey = event.timestamp?.slice(0, 10) ?? `undated-${event.id}`
        const previousDayKey =
          events[index - 1]?.timestamp?.slice(0, 10) ?? `undated-${events[index - 1]?.id ?? 'start'}`
        const showDay = index === 0 || dayKey !== previousDayKey
        const role = resolveConversationRole(event, props.aliasIndex)

        const actorLabel = extractActorValue(event) ?? (role === 'self' ? 'You' : event.contact ?? 'Unknown')
        const displayText = props.plainTextOnly ? eventConversationText(event) : eventSummaryText(event)
        const transcriptBlocks = props.plainTextOnly ? splitReadableTranscript(displayText) : []

        return (
          <div className={`conversation-item role-${role}`} key={event.id}>
            {showDay ? <div className="thread-day-separator">{formatThreadDay(event.timestamp)}</div> : null}
            <button
              className={`message-row role-${role}`}
              onClick={() => props.onEventClick(event.id)}
              type="button"
            >
              <div className="message-headline">
                <span className="message-type">{event.category}</span>
                <span className="message-timestamp">{formatThreadTimestamp(event.timestamp)}</span>
              </div>
              <div className="message-bubble">
                <div className="message-header-line">
                  <span className="message-actor">{actorLabel}</span>
                  <span className="message-time">{formatThreadTimestamp(event.timestamp)}</span>
                </div>
                {props.plainTextOnly && transcriptBlocks.length > 0 ? (
                  <div className="transcript-stream">
                    {transcriptBlocks.map((block, blockIndex) => (
                      <div className={`transcript-turn role-${role}`} key={`${event.id}-${blockIndex}`}>
                        <div className="transcript-turn-head">
                          {block.timestamp ? <span className="transcript-timestamp">{block.timestamp}</span> : null}
                          <strong className="transcript-actor">{block.actor ?? actorLabel}</strong>
                        </div>
                        <div className="transcript-body">
                          <HighlightedText terms={props.terms} text={block.text} />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="message-copy">
                    {displayText ? (
                      <>
                        <strong className="transcript-actor">{actorLabel}</strong>
                        <div className="transcript-body">
                          <HighlightedText terms={props.terms} text={displayText} />
                        </div>
                      </>
                    ) : (
                      <span className="muted-text">No readable chat text was recovered for this row.</span>
                    )}
                  </div>
                )}
              </div>
              <span className="message-source-line mono">
                [{event.id}] {event.sourceFile}
              </span>
            </button>
          </div>
        )
      })}
    </div>
  )
}

function scoreLabel(score: number) {
  if (score >= 8) return 'high'
  if (score >= 5) return 'medium'
  return 'low'
}

function sortContacts(contacts: ContactSummary[], mode: ContactSort) {
  const sorted = [...contacts]

  sorted.sort((left, right) => {
    if (mode === 'messages') {
      return right.messageCount - left.messageCount || right.interactions - left.interactions
    }
    if (mode === 'romance') {
      return right.romanticScore - left.romanticScore || right.messageCount - left.messageCount
    }
    if (mode === 'secrecy') {
      return right.secrecyScore - left.secrecyScore || right.interactions - left.interactions
    }
    if (mode === 'recent') {
      return right.recentChange - left.recentChange || right.interactions - left.interactions
    }
    if (mode === 'missing') {
      return Number(right.missingChat) - Number(left.missingChat) || right.interactions - left.interactions
    }

    return right.interactions - left.interactions || right.messageCount - left.messageCount
  })

  return sorted
}

function HighlightedText(props: { text: string; terms: string[] }) {
  if (!props.terms.length) {
    return <>{props.text}</>
  }

  const pattern = new RegExp(`(${props.terms.map((term) => escapeRegExp(term)).join('|')})`, 'gi')
  const parts = props.text.split(pattern)

  return (
    <>
      {parts.map((part, index) =>
        props.terms.some((term) => part.toLowerCase() === term.toLowerCase()) ? (
          <mark key={`${part}-${index}`}>{part}</mark>
        ) : (
          <span key={`${part}-${index}`}>{part}</span>
        ),
      )}
    </>
  )
}

function SectionHeader(props: { eyebrow: string; title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="section-heading">
      <div>
        <p className="eyebrow">{props.eyebrow}</p>
        <h2>{props.title}</h2>
        {props.subtitle ? <p className="section-copy">{props.subtitle}</p> : null}
      </div>
      {props.actions ? <div className="section-actions">{props.actions}</div> : null}
    </div>
  )
}

function MetricButton(props: {
  label: string
  value: string | number
  caption: string
  onClick: () => void
}) {
  return (
    <button className="metric-card" onClick={props.onClick} type="button">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
      <p>{props.caption}</p>
    </button>
  )
}

function ScorePill(props: { label: string; value: number }) {
  return (
    <span className={`score-pill score-${scoreLabel(props.value)}`}>
      {props.label} {props.value}/10
    </span>
  )
}

function DetailModal(props: {
  title: string
  subtitle?: string
  onClose: () => void
  children: ReactNode
  className?: string
}) {
  return (
    <div className="modal-backdrop" onClick={props.onClose} role="presentation">
      <section
        aria-modal="true"
        className={`modal-shell ${props.className ?? ''}`.trim()}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="modal-header">
          <div>
            <h3>{props.title}</h3>
            {props.subtitle ? <p className="section-copy">{props.subtitle}</p> : null}
          </div>
          <button className="ghost-button close-button" onClick={props.onClose} type="button">
            Close
          </button>
        </header>
        <div className="modal-body">{props.children}</div>
      </section>
    </div>
  )
}

export default function App() {
  const [selectedPlatform, setSelectedPlatform] = useState<Platform | null>(null)
  const [platformPickerOpen, setPlatformPickerOpen] = useState(true)
  const [lastPlatform, setLastPlatform] = useState<Platform | null>(null)
  const [uploads, setUploads] = useState<ParsedUpload[]>([])
  const [workspace, setWorkspace] = useState<WorkspaceDataset>(() => buildWorkspaceLite([]))
  const [isHydrating, setIsHydrating] = useState(true)
  const [status, setStatus] = useState('Choose a viewer to begin.')
  const [error, setError] = useState<string | null>(null)
  const [workspaceError, setWorkspaceError] = useState<string | null>(null)
  const [isWorkspaceLoading, setIsWorkspaceLoading] = useState(false)
  const [isLoadingZip, setIsLoadingZip] = useState(false)
  const [isLoadingFolder, setIsLoadingFolder] = useState(false)
  const [loadProgress, setLoadProgress] = useState({ percent: 0, label: '' })
  const [activeTab, setActiveTab] = useState<ActiveTab>('overview')
  const [notes, setNotes] = useState('')
  const [contactSearch, setContactSearch] = useState('')
  const [contactSort, setContactSort] = useState<ContactSort>('activity')
  const [yearFilter, setYearFilter] = useState<string>('all')
  const [comparisonYear, setComparisonYear] = useState<string>('all')
  const [selectedContact, setSelectedContact] = useState('')
  const [contactLabels, setContactLabels] = useState<Record<string, ContactLabel>>({})
  const [reviewLaterContacts, setReviewLaterContacts] = useState<Record<string, true>>({})
  const [contactGroupFilter, setContactGroupFilter] = useState<'all' | ContactLabel>('all')
  const [searchQuery, setSearchQuery] = useState('delete this, Jordan, address')
  const [threadMode, setThreadMode] = useState<ThreadMode>('chat')
  const [threadSort, setThreadSort] = useState<ThreadSort>('newest')
  const [threadSearch, setThreadSearch] = useState('')
  const [selectedThreadLimit, setSelectedThreadLimit] = useState(THREAD_PAGE_SIZE)
  const [modalThreadLimit, setModalThreadLimit] = useState(THREAD_PAGE_SIZE)
  const [modalState, setModalState] = useState<ModalState>(null)
  const [aiSettings, setAiSettings] = useState<AISettings>({
    provider: 'gemini',
    apiKey: '',
    model: DEFAULT_MODELS.gemini,
  })
  const [aiQuestion, setAiQuestion] = useState(
    'Scan the full export for flirtation, secrecy, missing contacts, deletions, media sent in each direction, and the strongest factual patterns with evidence IDs.',
  )
  const [aiResult, setAiResult] = useState<AIResult | null>(null)
  const [aiError, setAiError] = useState<string | null>(null)
  const [isAiLoading, setIsAiLoading] = useState(false)
  const [contactAiResults, setContactAiResults] = useState<Record<string, AIResult>>({})
  const [contactAiError, setContactAiError] = useState<string | null>(null)
  const [isContactAiLoading, setIsContactAiLoading] = useState(false)
  const [contactAiProgress, setContactAiProgress] = useState({ completed: 0, total: 1, label: '' })
  const [lockDraft, setLockDraft] = useState('')
  const [unlockDraft, setUnlockDraft] = useState('')
  const [isLocked, setIsLocked] = useState(false)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const cacheInputRef = useRef<HTMLInputElement>(null)
  const workspaceWorkerRef = useRef<Worker | null>(null)
  const workspaceRequestRef = useRef(0)
  const viewerConfig = selectedPlatform ? PLATFORM_CONFIG[selectedPlatform] : null
  const platformClass = selectedPlatform ? `platform-${selectedPlatform}` : ''

  const deferredContactSearch = useDeferredValue(contactSearch)
  const deferredSearchQuery = useDeferredValue(searchQuery)
  const deferredThreadSearch = useDeferredValue(threadSearch)

  useEffect(() => {
    folderInputRef.current?.setAttribute('webkitdirectory', '')
    folderInputRef.current?.setAttribute('directory', '')
    const storedSettings = window.sessionStorage.getItem(AI_SETTINGS_KEY)
    const storedLockCode = window.localStorage.getItem(LOCK_CODE_KEY)
    if (storedSettings) {
      try {
        setAiSettings(JSON.parse(storedSettings) as AISettings)
      } catch {
        window.sessionStorage.removeItem(AI_SETTINGS_KEY)
      }
    }
    setIsLocked(Boolean(storedLockCode))
    const storedPlatform = window.localStorage.getItem(LAST_PLATFORM_KEY)
    if (storedPlatform === 'snapchat' || storedPlatform === 'facebook') {
      setLastPlatform(storedPlatform)
    }
    setIsHydrating(false)
  }, [])

  useEffect(() => {
    const worker = new Worker(new URL('./lib/workspaceWorker.ts', import.meta.url), {
      type: 'module',
    })
    workspaceWorkerRef.current = worker

    return () => {
      worker.terminate()
      workspaceWorkerRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!selectedPlatform) return

    setIsHydrating(true)
    const notesKey = scopedStorageKey(NOTES_KEY, selectedPlatform)
    const labelsKey = scopedStorageKey(CONTACT_LABELS_KEY, selectedPlatform)
    const reviewKey = scopedStorageKey(REVIEW_LATER_KEY, selectedPlatform)
    const snapshotKey = scopedStorageKey('workspace', selectedPlatform)
    const sampleUpload = PLATFORM_CONFIG[selectedPlatform].sampleUpload

    setNotes(window.localStorage.getItem(notesKey) ?? '')
    const storedLabels = window.localStorage.getItem(labelsKey)
    if (storedLabels) {
      try {
        setContactLabels(JSON.parse(storedLabels) as Record<string, ContactLabel>)
      } catch {
        window.localStorage.removeItem(labelsKey)
        setContactLabels({})
      }
    } else {
      setContactLabels({})
    }
    try {
      const storedReviewLater = window.localStorage.getItem(reviewKey)
      setReviewLaterContacts(storedReviewLater ? (JSON.parse(storedReviewLater) as Record<string, true>) : {})
    } catch {
      window.localStorage.removeItem(reviewKey)
      setReviewLaterContacts({})
    }

    setSelectedContact('')
    setSearchQuery('delete this, Jordan, address')
    setThreadSearch('')
    setModalState(null)
    setAiResult(null)
    setContactAiError(null)
    setWorkspaceError(null)
    setLoadProgress({ percent: 0, label: '' })
    setStatus(`Loading ${PLATFORM_CONFIG[selectedPlatform].label} workspace...`)

    void loadSnapshot(snapshotKey)
      .then((snapshot) => {
        if (snapshot?.uploads?.length) {
          setUploads(snapshot.uploads)
          setContactAiResults(snapshot.contactAiResults ?? {})
          if (snapshot.reviewLaterContacts?.length) {
            setReviewLaterContacts(Object.fromEntries(snapshot.reviewLaterContacts.map((name) => [name, true] as const)))
          }
          setStatus(
            `Restored ${snapshot.uploads.length} saved ${PLATFORM_CONFIG[selectedPlatform].label} upload(s) from this browser.`,
          )
          return
        }

        setUploads([sampleUpload])
        setContactAiResults({})
        setStatus(`${PLATFORM_CONFIG[selectedPlatform].label} demo workspace loaded.`)
      })
      .catch(() => {
        setUploads([sampleUpload])
        setContactAiResults({})
        setStatus(`${PLATFORM_CONFIG[selectedPlatform].label} demo workspace loaded.`)
      })
      .finally(() => setIsHydrating(false))
  }, [selectedPlatform])

  useEffect(() => {
    if (!selectedPlatform || isHydrating) return
    window.localStorage.setItem(scopedStorageKey(NOTES_KEY, selectedPlatform), notes)
  }, [isHydrating, notes, selectedPlatform])
  useEffect(() => {
    if (!selectedPlatform || isHydrating) return
    window.localStorage.setItem(
      scopedStorageKey(CONTACT_LABELS_KEY, selectedPlatform),
      JSON.stringify(contactLabels),
    )
  }, [contactLabels, isHydrating, selectedPlatform])
  useEffect(() => {
    if (!selectedPlatform || isHydrating) return
    window.localStorage.setItem(
      scopedStorageKey(REVIEW_LATER_KEY, selectedPlatform),
      JSON.stringify(reviewLaterContacts),
    )
  }, [isHydrating, reviewLaterContacts, selectedPlatform])
  useEffect(
    () => window.sessionStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(aiSettings)),
    [aiSettings],
  )
  useEffect(() => {
    if (loadProgress.percent < 100 || isLoadingZip || isLoadingFolder || isWorkspaceLoading) {
      return
    }

    const timeout = window.setTimeout(() => {
      setLoadProgress({ percent: 0, label: '' })
    }, 1400)

    return () => window.clearTimeout(timeout)
  }, [isLoadingFolder, isLoadingZip, isWorkspaceLoading, loadProgress])
  useEffect(() => {
    if (isHydrating || !selectedPlatform) return

    void saveSnapshot({
      uploads: uploads as ParsedUpload[],
      contactAiResults,
      reviewLaterContacts: Object.keys(reviewLaterContacts).filter((name) => reviewLaterContacts[name]),
      savedAt: new Date().toISOString(),
    }, scopedStorageKey('workspace', selectedPlatform)).catch(() => {
      setWorkspaceError('Local workspace persistence failed. The dashboard will keep working for this session.')
    })
  }, [contactAiResults, isHydrating, reviewLaterContacts, selectedPlatform, uploads])
  useEffect(() => {
    if (!selectedPlatform) {
      return
    }

    const worker = workspaceWorkerRef.current
    if (!worker) {
      setWorkspace(buildWorkspaceLite(uploads))
      setLoadProgress({ percent: 100, label: 'Thread index ready.' })
      return
    }

    const requestId = `workspace-${Date.now()}-${workspaceRequestRef.current + 1}`
    workspaceRequestRef.current += 1
    setIsWorkspaceLoading(true)
    setWorkspaceError(null)
    setLoadProgress((current) => ({
      percent: Math.max(current.percent, 96),
      label: 'Building contact and thread index...',
    }))

    const handleMessage = (
      event: MessageEvent<{ requestId: string; workspace?: WorkspaceDataset; error?: string }>,
    ) => {
      if (event.data.requestId !== requestId) {
        return
      }

      worker.removeEventListener('message', handleMessage as EventListener)
      setIsWorkspaceLoading(false)

      if (event.data.error) {
        setWorkspaceError(event.data.error)
        return
      }

      if (event.data.workspace) {
        setWorkspace(event.data.workspace)
        setLoadProgress({ percent: 100, label: 'Thread index ready.' })
      }
    }

    worker.addEventListener('message', handleMessage as EventListener)
    worker.postMessage({ requestId, uploads })

    return () => {
      worker.removeEventListener('message', handleMessage as EventListener)
    }
  }, [selectedPlatform, uploads])
  useEffect(() => {
    if (!modalState) return

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setModalState(null)
      }
    }

    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [modalState])
  const eventsById = useMemo(
    () => new Map(workspace.events.map((event) => [event.id, event])),
    [workspace.events],
  )
  const contactIndex = useMemo(
    () => new Map(workspace.contacts.map((contact) => [contact.name, contact])),
    [workspace.contacts],
  )
  const availableYears = useMemo(() => uniqueYears(workspace.events), [workspace.events])
  const scopedEvents = useMemo(() => {
    if (yearFilter === 'all') return workspace.events
    const targetYear = Number(yearFilter)
    return workspace.events.filter((event) => yearFromTimestamp(event.timestamp) === targetYear)
  }, [workspace.events, yearFilter])
  const scopedEventsByContact = useMemo(() => {
    const map = new Map<string, NormalizedEvent[]>()
    scopedEvents.forEach((event) => {
      if (!event.contact) return
      const current = map.get(event.contact) ?? []
      current.push(event)
      map.set(event.contact, current)
    })
    return map
  }, [scopedEvents])
  const scopedContactNames = useMemo(() => [...scopedEventsByContact.keys()], [scopedEventsByContact])
  const selectedYearValue = yearFilter === 'all' ? 'all' : Number(yearFilter)
  const compareYearValue = comparisonYear === 'all' ? 'all' : Number(comparisonYear)
  const contactYearHistory = useMemo(() => {
    const map = new Map<string, number[]>()

    workspace.events.forEach((event) => {
      if (!event.contact) return
      const year = yearFromTimestamp(event.timestamp)
      if (year === null) return
      const current = map.get(event.contact) ?? []
      if (!current.includes(year)) {
        current.push(year)
        current.sort((left, right) => left - right)
      }
      map.set(event.contact, current)
    })

    return map
  }, [workspace.events])
  const timelineBuckets = useMemo(
    () => (yearFilter === 'all' ? workspace.timeline : buildTimelineBuckets(scopedEvents)),
    [scopedEvents, workspace.timeline, yearFilter],
  )
  const scopedContactCounts = useMemo(
    () => new Map([...scopedEventsByContact.entries()].map(([name, events]) => [name, events.length] as const)),
    [scopedEventsByContact],
  )
  const yearComparison = useMemo(() => {
    if (selectedYearValue === 'all' || compareYearValue === 'all') {
      return null
    }

    const selectedYear = selectedYearValue
    const compareYear = compareYearValue
    const selectedContacts = new Set(scopedEvents.map((event) => event.contact).filter(Boolean) as string[])
    const compareContacts = new Set(
      workspace.events
        .filter((event) => yearFromTimestamp(event.timestamp) === compareYear)
        .map((event) => event.contact)
        .filter(Boolean) as string[],
    )

    const shared = [...selectedContacts].filter((contact) => compareContacts.has(contact))
    const newThisYear = [...selectedContacts].filter((contact) => !compareContacts.has(contact))
    const compareOnly = [...compareContacts].filter((contact) => !selectedContacts.has(contact))

    const reappeared = newThisYear
      .map((contact) => {
        const years = contactYearHistory.get(contact) ?? []
        const priorYears = years.filter((year) => year < selectedYear)
        const lastPriorYear = priorYears[priorYears.length - 1]
        if (lastPriorYear === undefined || selectedYear - lastPriorYear <= 1) {
          return null
        }

        return {
          contact,
          gap: selectedYear - lastPriorYear,
          previousYear: lastPriorYear,
          years,
          deletionIndicators: workspace.contacts.find((entry) => entry.name === contact)?.deletionIndicators ?? 0,
        }
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .sort((left, right) => right.gap - left.gap)

    return {
      selectedYear,
      compareYear,
      selectedCount: selectedContacts.size,
      compareCount: compareContacts.size,
      sharedCount: shared.length,
      newCount: newThisYear.length,
      compareOnlyCount: compareOnly.length,
      reappeared,
    }
  }, [compareYearValue, contactYearHistory, scopedEvents, selectedYearValue, workspace.contacts, workspace.events])
  const uploadIndex = useMemo(
    () => new Map(workspace.uploads.map((upload) => [upload.id, upload])),
    [workspace.uploads],
  )
  const aliasIndex = useMemo(() => buildAliasIndex(workspace.uploads), [workspace.uploads])
  const signalIndex = useMemo(
    () => new Map(workspace.signals.map((signal) => [signal.id, signal])),
    [workspace.signals],
  )
  const fileSummariesByUpload = useMemo(() => {
    const map = new Map<string, FileSummary[]>()
    workspace.fileSummaries.forEach((file) => {
      const current = map.get(file.uploadId) ?? []
      current.push(file)
      map.set(file.uploadId, current)
    })
    return map
  }, [workspace.fileSummaries])

  useEffect(() => {
    setSelectedThreadLimit(THREAD_PAGE_SIZE)
  }, [selectedContact, threadMode, threadSort])
  useEffect(() => {
    setModalThreadLimit(THREAD_PAGE_SIZE)
  }, [modalState, threadMode, threadSort])

  const filteredContacts = useMemo(() => {
    const needle = deferredContactSearch.trim().toLowerCase()
    return sortContacts(
      workspace.contacts.filter((contact) => {
        const label = contactLabels[contact.name] ?? 'unknown'
        if (contactGroupFilter !== 'all' && label !== contactGroupFilter) return false
        return !needle || contact.name.toLowerCase().includes(needle)
      }),
      contactSort,
    )
  }, [contactGroupFilter, contactLabels, contactSort, deferredContactSearch, workspace.contacts])

  useEffect(() => {
    if (!workspace.contacts.length) {
      setSelectedContact('')
      return
    }

    const preferred = scopedContactNames[0] ?? filteredContacts[0]?.name ?? workspace.contacts[0]?.name ?? ''
    const selectedIsValid =
      workspace.contacts.some((contact) => contact.name === selectedContact) &&
      (yearFilter === 'all' || scopedEventsByContact.has(selectedContact))

    if (!selectedIsValid && preferred && preferred !== selectedContact) {
      setSelectedContact(preferred)
    }
  }, [filteredContacts, scopedContactNames, scopedEventsByContact, selectedContact, workspace.contacts, yearFilter])

  const selectedSummary =
    contactIndex.get(selectedContact) ??
    (scopedContactNames[0] ? contactIndex.get(scopedContactNames[0]) ?? null : null) ??
    filteredContacts[0] ??
    workspace.contacts[0] ??
    null

  const selectedThreadSourceFiles = useMemo(() => {
    if (!selectedSummary) return new Set<string>()
    return new Set((scopedEventsByContact.get(selectedSummary.name) ?? []).map((event) => event.sourceFile))
  }, [scopedEventsByContact, selectedSummary])

  const selectedThread = useMemo(() => {
    if (!selectedSummary) return []
    if (selectedPlatform === 'snapchat') {
      // Snapchat chat exports often store each side of the same conversation in the
      // same source file but with different sender/contact values. Group by source
      // file so both sides stay in one readable thread.
      return scopedEvents.filter((event) => selectedThreadSourceFiles.has(event.sourceFile))
    }

    return scopedEventsByContact.get(selectedSummary.name) ?? []
  }, [scopedEvents, scopedEventsByContact, selectedPlatform, selectedSummary, selectedThreadSourceFiles])
  const selectedThreadSorted = useMemo(
    () => sortThreadEvents(selectedThread, threadSort),
    [selectedThread, threadSort],
  )
  const selectedThreadNewestFirst = useMemo(
    () => sortThreadEvents(selectedThread, 'newest'),
    [selectedThread],
  )
  const selectedThreadOldestFirst = useMemo(
    () => sortThreadEvents(selectedThread, 'oldest'),
    [selectedThread],
  )
  const selectedThreadMessageCount = useMemo(
    () => selectedThread.filter((event) => event.category === 'chat').length,
    [selectedThread],
  )

  const selectedVisibleThread = useMemo(() => {
    const threadTerms = queryTermsFromInput(deferredThreadSearch)
    return selectedThreadSorted.filter((event) => {
      if (threadMode === 'chat' && event.category !== 'chat') {
        return false
      }
      if (threadMode === 'chat' && !eventConversationText(event)) {
        return false
      }
      if (!threadTerms.length) {
        return true
      }

      const haystack = compact(
        [eventConversationText(event), event.detail, event.evidenceText, event.sourceFile].filter(Boolean).join(' '),
      ).toLowerCase()

      return threadTerms.some((term) => haystack.includes(term))
    })
  }, [deferredThreadSearch, selectedThreadSorted, threadMode])
  const selectedThreadTerms = useMemo(
    () => queryTermsFromInput(deferredThreadSearch),
    [deferredThreadSearch],
  )
  const selectedVisibleThreadPage = useMemo(
    () => selectedVisibleThread.slice(0, selectedThreadLimit),
    [selectedThreadLimit, selectedVisibleThread],
  )

  function handleDownloadSelectedTranscript() {
    if (!selectedSummary) return

    const transcript = buildReadableTranscript(selectedVisibleThread, aliasIndex, selectedPlatform ?? 'snapchat')
    downloadPlainText(
      `${selectedSummary.name.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'thread'}-transcript.txt`,
      transcript || 'No readable transcript was recovered for this selection.',
    )
  }

  function handleDownloadSelectedTranscriptHtml() {
    if (!selectedSummary) return

    const html = buildChatExportHtml(selectedSummary.name, selectedVisibleThread, aliasIndex, selectedPlatform ?? 'snapchat')
    downloadHtml(
      `${selectedSummary.name.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'thread'}-transcript.html`,
      html,
    )
  }

  function handleDownloadReviewLaterContacts() {
    downloadReviewContactsCsv(reviewLaterQueue)
  }

  const selectedDateMarkers = useMemo(() => buildDateMarkers(selectedThread), [selectedThread])
  const selectedMediaEvents = useMemo(
    () => selectedThread.filter((event) => isMediaEvent(event)),
    [selectedThread],
  )
  const selectedEntities = useMemo(
    () =>
      selectedSummary
        ? workspace.entities.filter((entity) => entity.contacts.includes(selectedSummary.name)).slice(0, 20)
        : [],
    [selectedSummary, workspace.entities],
  )
  const selectedSourceFiles = useMemo(
    () => [...new Set(selectedThread.map((event) => event.sourceFile))].slice(0, 10),
    [selectedThread],
  )
  const selectedMarkerMap = useMemo(
    () => Object.fromEntries(selectedDateMarkers.map((marker) => [marker.label, marker.event])),
    [selectedDateMarkers],
  )
  const selectedContactAiResult = selectedSummary ? contactAiResults[selectedSummary.name] ?? null : null
  const selectedThreadTokenEstimate = useMemo(
    () => estimateTokenCount(threadMode === 'chat' ? selectedThread.filter((event) => event.category === 'chat') : selectedThread),
    [selectedThread, threadMode],
  )
  const selectedThreadChunkEstimate = useMemo(
    () => Math.max(1, Math.ceil(selectedThreadTokenEstimate / 3500)),
    [selectedThreadTokenEstimate],
  )
  const selectedThreadLatestEvent = selectedThreadNewestFirst[0] ?? null
  const selectedThreadOldestEvent = selectedThreadOldestFirst[0] ?? null
  const selectedContactYears = useMemo(
    () => (selectedSummary ? contactYearHistory.get(selectedSummary.name) ?? [] : []),
    [contactYearHistory, selectedSummary],
  )
  const selectedContactYearGaps = useMemo(() => {
    if (selectedContactYears.length < 2) return []
    const gaps: Array<{ start: number; end: number; span: number }> = []
    for (let index = 1; index < selectedContactYears.length; index += 1) {
      const prev = selectedContactYears[index - 1]
      const current = selectedContactYears[index]
      const span = current - prev
      if (span > 1) {
        gaps.push({ start: prev, end: current, span })
      }
    }
    return gaps
  }, [selectedContactYears])
  const contactAiProgressPercent = useMemo(
    () => clampPercent((contactAiProgress.completed / Math.max(contactAiProgress.total, 1)) * 100),
    [contactAiProgress],
  )

  const searchTerms = useMemo(() => queryTermsFromInput(deferredSearchQuery), [deferredSearchQuery])
  const searchHits = useMemo(() => {
    if (!searchTerms.length) return []

    return scopedEvents
      .filter((event) => {
        const haystack = compact(
          [event.contact, event.text, event.detail, event.evidenceText, event.sourceFile]
            .filter(Boolean)
            .join(' '),
        ).toLowerCase()

        return searchTerms.some((term) => haystack.includes(term))
      })
      .sort((left, right) => {
        if (left.category === 'chat' && right.category !== 'chat') return -1
        if (left.category !== 'chat' && right.category === 'chat') return 1
        if (left.timestamp && right.timestamp) return right.timestamp.localeCompare(left.timestamp)
        return left.id.localeCompare(right.id)
      })
  }, [scopedEvents, searchTerms])

  const deletionEvents = useMemo(
    () => scopedEvents.filter((event) => hasDeletionIndicator(event)),
    [scopedEvents],
  )
  const missingChatContacts = useMemo(
    () => workspace.contacts.filter((contact) => contact.missingChat),
    [workspace.contacts],
  )
  const priorityContacts = useMemo(
    () =>
      [...workspace.contacts]
        .sort(
          (left, right) =>
            right.secrecyScore + right.romanticScore + right.intensityScore -
            (left.secrecyScore + left.romanticScore + left.intensityScore),
        )
        .slice(0, 5),
    [workspace.contacts],
  )
  const contactGroups = useMemo(
    () => ({
      male: workspace.contacts.filter((contact) => (contactLabels[contact.name] ?? 'unknown') === 'male')
        .length,
      female: workspace.contacts.filter((contact) => (contactLabels[contact.name] ?? 'unknown') === 'female')
        .length,
      unknown: workspace.contacts.filter((contact) => (contactLabels[contact.name] ?? 'unknown') === 'unknown')
        .length,
    }),
    [contactLabels, workspace.contacts],
  )
  const reviewLaterQueue = useMemo(
    () =>
      sortContacts(
        workspace.contacts.filter((contact) => Boolean(reviewLaterContacts[contact.name])),
        'recent',
      ),
    [reviewLaterContacts, workspace.contacts],
  )
  const requiresAiForDeepReview = workspace.stats.totalEvents >= LARGE_EXPORT_THRESHOLD

  function mergeUploads(nextUploads: typeof uploads) {
    setUploads((current) => {
      const sampleId = viewerConfig?.sampleUpload.upload.id
      const base = sampleId && current.length === 1 && current[0].upload.id === sampleId ? [] : current
      return [...base, ...nextUploads]
    })
  }

  async function handleZipUpload(event: ChangeEvent<HTMLInputElement>) {
    if (!viewerConfig) return
    const files = [...(event.target.files ?? [])]
    if (!files.length) return
    setIsLoadingZip(true)
    setError(null)
    setLoadProgress({ percent: 0, label: 'Opening zip export...' })
    setStatus(`Parsing ${viewerConfig.label} zip upload${files.length === 1 ? '' : 's'}...`)

    try {
      const parsed: ParsedUpload[] = []

      for (const [index, file] of files.entries()) {
        const upload = await viewerConfig.parseZip(file, (progress) => {
          const base = (index / files.length) * 100
          const span = 100 / files.length
          setLoadProgress({
            percent: Math.min(100, base + (progress.percent / 100) * span),
            label: `${file.name}: ${progress.label}`,
          })
        })
        parsed.push(upload)
      }

      startTransition(() => {
        mergeUploads(parsed)
        setActiveTab('overview')
      })
      setStatus(
        `Loaded ${parsed.reduce((sum, upload) => sum + upload.events.length, 0)} normalized events from zip upload(s).`,
      )
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Zip parsing failed.')
      setStatus('Zip parsing failed.')
    } finally {
      setLoadProgress((current) =>
        current.percent >= 100 ? current : { percent: 0, label: '' },
      )
      setIsLoadingZip(false)
      event.target.value = ''
    }
  }

  async function handleFolderUpload(event: ChangeEvent<HTMLInputElement>) {
    if (!viewerConfig) return
    const files = [...(event.target.files ?? [])]
    if (!files.length) return
    setIsLoadingFolder(true)
    setError(null)
    setLoadProgress({ percent: 0, label: 'Scanning extracted export folder...' })
    setStatus(viewerConfig.folderStatus)

    try {
      const parsed = await viewerConfig.parseFolder(files, setLoadProgress)
      startTransition(() => {
        mergeUploads([parsed])
        setActiveTab('overview')
      })
      setStatus(`Loaded extracted folder ${parsed.upload.fileName} and skipped media files.`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Folder parsing failed.')
      setStatus('Folder parsing failed.')
    } finally {
      setLoadProgress((current) =>
        current.percent >= 100 ? current : { percent: 0, label: '' },
      )
      setIsLoadingFolder(false)
      event.target.value = ''
    }
  }

  async function handleCacheUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return

    setError(null)
    setLoadProgress({ percent: 10, label: 'Loading cached workspace JSON...' })
    setStatus(`Loading cached workspace from ${file.name}...`)

    try {
      const payload = JSON.parse(await file.text()) as unknown
      const nextUploads = Array.isArray(payload)
        ? payload.filter(isParsedUploadLike)
        : isParsedUploadLike(payload)
          ? [payload]
          : Array.isArray((payload as { uploads?: unknown })?.uploads)
            ? ((payload as { uploads: unknown[] }).uploads.filter(isParsedUploadLike) as ParsedUpload[])
            : []

      if (!nextUploads.length) {
        throw new Error('This JSON file does not contain a supported cached upload payload.')
      }

      setUploads(nextUploads)
      setContactAiResults({})
      setLoadProgress({ percent: 94, label: 'Cached workspace loaded. Building thread index...' })
      setStatus(`Loaded cached workspace with ${nextUploads.length} upload(s).`)
      setActiveTab('chats')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Cached JSON could not be loaded.')
      setStatus('Cached JSON load failed.')
    } finally {
      event.target.value = ''
    }
  }

  async function handleAiRun() {
    setIsAiLoading(true)
    setAiError(null)
    try {
      setAiResult(await runAIReview(aiSettings, workspace, aiQuestion))
      setActiveTab('ai')
    } catch (caught) {
      setAiError(caught instanceof Error ? caught.message : 'AI analysis failed.')
    } finally {
      setIsAiLoading(false)
    }
  }

  async function handleSelectedContactAiRun() {
    if (!selectedSummary) return

    setIsContactAiLoading(true)
    setContactAiError(null)
    setContactAiProgress({ completed: 0, total: 1, label: 'Preparing selected thread' })

    try {
      const result = await runContactAIReview(
        aiSettings,
        workspace,
        selectedSummary,
        selectedThread,
        selectedEntities,
        CONTACT_AI_QUESTION,
        setContactAiProgress,
      )

      setContactAiResults((current) => ({
        ...current,
        [selectedSummary.name]: result,
      }))
    } catch (caught) {
      setContactAiError(caught instanceof Error ? caught.message : 'Selected-thread AI analysis failed.')
    } finally {
      setContactAiProgress((current) => ({ ...current, completed: current.total }))
      setIsContactAiLoading(false)
    }
  }

  async function handleResetLocalWorkspace() {
    if (!selectedPlatform || !viewerConfig) return
    await clearSnapshot(scopedStorageKey('workspace', selectedPlatform))
    window.localStorage.removeItem(scopedStorageKey(REVIEW_LATER_KEY, selectedPlatform))
    setUploads([viewerConfig.sampleUpload])
    setContactAiResults({})
    setReviewLaterContacts({})
    setAiResult(null)
    setSelectedContact('')
    setStatus(`Local ${viewerConfig.label} workspace cleared. Demo workspace loaded.`)
  }

  function handlePlatformSelection(platform: Platform) {
    window.localStorage.setItem(LAST_PLATFORM_KEY, platform)
    setLastPlatform(platform)
    setSelectedPlatform(platform)
    setPlatformPickerOpen(false)
    setActiveTab(platform === 'facebook' ? 'chats' : 'overview')
  }

  function handleSaveLockCode() {
    const code = lockDraft.trim()
    if (code.length < 4) {
      setError('Use a lock code with at least 4 characters.')
      return
    }

    window.localStorage.setItem(LOCK_CODE_KEY, code)
    setIsLocked(true)
    setLockDraft('')
    setUnlockDraft('')
    setError(null)
    setStatus('Local browser lock enabled for this dashboard.')
  }

  function handleUnlock() {
    const saved = window.localStorage.getItem(LOCK_CODE_KEY)
    if (!saved) {
      setIsLocked(false)
      return
    }

    if (unlockDraft === saved) {
      setIsLocked(false)
      setUnlockDraft('')
      setError(null)
      return
    }

    setError('Lock code did not match.')
  }

  function handleDisableLock() {
    window.localStorage.removeItem(LOCK_CODE_KEY)
    setIsLocked(false)
    setUnlockDraft('')
    setLockDraft('')
    setStatus('Local browser lock removed.')
  }

  function openMetricModal(key: MetricKey) {
    setModalState({ type: 'metric', key })
  }

  function openContactModal(contactName: string) {
    setSelectedContact(contactName)
    setThreadSearch('')
    setThreadMode('chat')
    setModalState({ type: 'contact', contactName })
  }

  function openContactFocusModal(contactName: string) {
    setSelectedContact(contactName)
    setThreadSearch('')
    setThreadMode('chat')
    setModalState({ type: 'thread-focus', contactName })
  }

  function toggleReviewLater(contactName: string) {
    setReviewLaterContacts((current) => {
      const next = { ...current }
      if (next[contactName]) {
        delete next[contactName]
      } else {
        next[contactName] = true
      }
      return next
    })
  }

  function moveModalContact(direction: -1 | 1) {
    if (!modalState || (modalState.type !== 'contact' && modalState.type !== 'thread-focus')) return
    const names = (filteredContacts.length ? filteredContacts : workspace.contacts).map((contact) => contact.name)
    const index = names.indexOf(modalState.contactName)
    if (index < 0) return
    const nextName = names[(index + direction + names.length) % names.length]
    setSelectedContact(nextName)
    setThreadSearch('')
    setModalState({ type: modalState.type, contactName: nextName })
  }

  function renderMetricModal(key: MetricKey) {
    if (key === 'contacts') {
      return (
        <DetailModal
          onClose={() => setModalState(null)}
          subtitle="All detected contacts, sorted by activity."
          title="Detected contacts"
        >
          <div className="modal-list">
            {workspace.contacts.map((contact) => (
              <button
                className="list-button"
                key={contact.name}
                onClick={() => openContactModal(contact.name)}
                type="button"
              >
                <div className="list-head">
                  <strong>{contact.name}</strong>
                  <span>{contact.interactions} events</span>
                </div>
                <p>
                  {contact.messageCount} chat rows, {contact.activeDays} active days, peak {contact.peakHour ?? '--'}:00
                </p>
              </button>
            ))}
          </div>
        </DetailModal>
      )
    }

    if (key === 'threads') {
      return (
        <DetailModal
          onClose={() => setModalState(null)}
          subtitle="Contacts with the highest visible chat volume."
          title="Thread volume"
        >
          <div className="modal-list">
            {sortContacts(workspace.contacts, 'messages').map((contact) => (
              <button
                className="list-button"
                key={contact.name}
                onClick={() => openContactModal(contact.name)}
                type="button"
              >
                <div className="list-head">
                  <strong>{contact.name}</strong>
                  <span>{contact.messageCount} chat rows</span>
                </div>
                <p>
                  Intensity {contact.intensityScore}/10, secrecy {contact.secrecyScore}/10, flirt {contact.romanticScore}/10
                </p>
              </button>
            ))}
          </div>
        </DetailModal>
      )
    }

    if (key === 'missing') {
      return (
        <DetailModal
          onClose={() => setModalState(null)}
          subtitle="Contacts that appear in friend/search metadata but have no parsed chat rows."
          title="Missing thread candidates"
        >
          <div className="modal-list">
            {missingChatContacts.map((contact) => (
              <button
                className="list-button"
                key={contact.name}
                onClick={() => openContactModal(contact.name)}
                type="button"
              >
                <div className="list-head">
                  <strong>{contact.name}</strong>
                  <span>{contact.searchCount} search / {contact.friendEventCount} friend rows</span>
                </div>
                <p>Linked evidence exists, but no chat rows were parsed for this contact.</p>
              </button>
            ))}
            {missingChatContacts.length === 0 ? <p className="empty-state">No missing-thread candidates.</p> : null}
          </div>
        </DetailModal>
      )
    }

    if (key === 'deletions') {
      return (
        <DetailModal
          onClose={() => setModalState(null)}
          subtitle="Rows containing delete, remove, clear, block, or unsave style indicators."
          title="Deletion and removal indicators"
        >
          <div className="modal-list">
            {deletionEvents.map((event) => (
              <button
                className="list-button"
                key={event.id}
                onClick={() => setModalState({ type: 'event', eventId: event.id })}
                type="button"
              >
                <div className="list-head">
                  <strong>{event.contact ?? event.category}</strong>
                  <span>{formatDate(event.timestamp)}</span>
                </div>
                <p>{compact(event.text ?? event.detail ?? event.evidenceText)}</p>
              </button>
            ))}
            {deletionEvents.length === 0 ? <p className="empty-state">No deletion indicators were found.</p> : null}
          </div>
        </DetailModal>
      )
    }

    if (key === 'timing') {
      return (
        <DetailModal
          onClose={() => setModalState(null)}
          subtitle="Chat timing is based on parsed chat rows when available."
          title="Peak activity windows"
        >
          <div className="modal-grid two-column">
            <article className="modal-card">
              <h4>By hour</h4>
              <div className="bar-list">
                {workspace.hourBuckets.map((bucket) => (
                  <button className="bar-row" key={bucket.hour} onClick={() => setModalState(null)} type="button">
                    <span>{bucket.hour.toString().padStart(2, '0')}:00</span>
                    <div className="inline-bar">
                      <div
                        className="inline-fill"
                        style={{
                          width: `${Math.max(
                            4,
                            (bucket.count / Math.max(...workspace.hourBuckets.map((item) => item.count), 1)) * 100,
                          )}%`,
                        }}
                      />
                    </div>
                    <strong>{bucket.count}</strong>
                  </button>
                ))}
              </div>
            </article>
            <article className="modal-card">
              <h4>By weekday</h4>
              <div className="bar-list">
                {workspace.weekdayBuckets.map((bucket) => (
                  <button className="bar-row" key={bucket.label} onClick={() => setModalState(null)} type="button">
                    <span>{bucket.label}</span>
                    <div className="inline-bar">
                      <div
                        className="inline-fill"
                        style={{
                          width: `${Math.max(
                            4,
                            (bucket.count / Math.max(...workspace.weekdayBuckets.map((item) => item.count), 1)) * 100,
                          )}%`,
                        }}
                      />
                    </div>
                    <strong>{bucket.count}</strong>
                  </button>
                ))}
              </div>
            </article>
          </div>
        </DetailModal>
      )
    }

    return (
      <DetailModal
        onClose={() => setModalState(null)}
        subtitle="Supported and skipped files from every loaded upload."
        title="File coverage"
      >
        <div className="modal-list">
          {workspace.fileSummaries.map((file) => (
            <button
              className="list-button"
              key={`${file.uploadId}-${file.path}`}
              onClick={() => setModalState({ type: 'file', path: file.path, uploadId: file.uploadId })}
              type="button"
            >
              <div className="list-head">
                <strong>{file.path}</strong>
                <span>{file.rows} rows</span>
              </div>
              <p>
                {file.category} / {file.supported ? 'supported' : 'skipped'}
              </p>
            </button>
          ))}
        </div>
      </DetailModal>
    )
  }

  function renderModal() {
    if (!modalState) return null

    if (modalState.type === 'metric') {
      return renderMetricModal(modalState.key)
    }

    if (modalState.type === 'contact' || modalState.type === 'thread-focus') {
      const summary = contactIndex.get(modalState.contactName)
      if (!summary) return null
      const isFocus = modalState.type === 'thread-focus'
      const thread = scopedEventsByContact.get(summary.name) ?? []
      const orderedThread = sortThreadEvents(thread, threadSort)
      const dateMarkers = buildDateMarkers(orderedThread)
      const mediaEvents = orderedThread.filter((event) => isMediaEvent(event))
      const modalTerms = queryTermsFromInput(deferredThreadSearch)
      const visibleThread = orderedThread.filter((event) => {
        if (threadMode === 'chat' && event.category !== 'chat') return false
        if (threadMode === 'chat' && !eventConversationText(event)) return false
        if (!modalTerms.length) return true
        const haystack = compact(
          [eventConversationText(event), event.detail, event.evidenceText, event.sourceFile].filter(Boolean).join(' '),
        ).toLowerCase()
        return modalTerms.some((term) => haystack.includes(term))
      })
      const visibleThreadPage = visibleThread.slice(0, modalThreadLimit)
      const contactEntities = workspace.entities
        .filter((entity) => entity.contacts.includes(summary.name))
        .slice(0, 12)
      const contactHits = workspace.keywordHits.filter((hit) => hit.contact === summary.name)

      if (isFocus) {
        return (
          <DetailModal
            className="chat-focus-modal"
            onClose={() => setModalState(null)}
            subtitle="Chat-only transcript view for screenshots and exports."
            title={summary.name}
          >
            <div className="modal-toolbar">
              <div className="button-row">
                <button className="ghost-button" onClick={() => moveModalContact(-1)} type="button">
                  Prev contact
                </button>
                <button className="ghost-button" onClick={() => moveModalContact(1)} type="button">
                  Next contact
                </button>
                <button className="secondary-button" onClick={() => setModalState({ type: 'contact', contactName: summary.name })} type="button">
                  Full details
                </button>
                <button
                  className={reviewLaterContacts[summary.name] ? 'label-button active' : 'label-button'}
                  onClick={() => toggleReviewLater(summary.name)}
                  type="button"
                >
                  {reviewLaterContacts[summary.name] ? 'Saved' : 'Review later'}
                </button>
              </div>
              <div className="button-row">
                <button className="ghost-button" onClick={handleDownloadSelectedTranscript} type="button">
                  Download TXT
                </button>
                <button className="ghost-button" onClick={handleDownloadSelectedTranscriptHtml} type="button">
                  Download HTML
                </button>
              </div>
            </div>

            <div className="thread-toolbar">
              <div className="button-row">
                <button
                  className={threadSort === 'newest' ? 'tab-button active' : 'tab-button'}
                  onClick={() => setThreadSort('newest')}
                  type="button"
                >
                  Newest first
                </button>
                <button
                  className={threadSort === 'oldest' ? 'tab-button active' : 'tab-button'}
                  onClick={() => setThreadSort('oldest')}
                  type="button"
                >
                  Oldest first
                </button>
                <button
                  className={threadMode === 'chat' ? 'tab-button active' : 'tab-button'}
                  onClick={() => setThreadMode('chat')}
                  type="button"
                >
                  Chat only
                </button>
                <button
                  className={threadMode === 'all' ? 'tab-button active' : 'tab-button'}
                  onClick={() => setThreadMode('all')}
                  type="button"
                >
                  All linked rows
                </button>
              </div>
              <label className="search-field inline-search">
                <span>Find inside this thread</span>
                <input
                  onChange={(event) => setThreadSearch(event.target.value)}
                  placeholder="Name, phrase, address, delete..."
                  type="search"
                  value={threadSearch}
                />
              </label>
            </div>

            <div className="thread-scroll chat-focus-scroll main-thread-scroll">
              {selectedPlatform === 'facebook' ? (
                <FacebookConversationList
                  aliasIndex={aliasIndex}
                  events={visibleThreadPage}
                  onEventClick={(eventId) => setModalState({ type: 'event', eventId })}
                  sortOrder={threadSort}
                  terms={modalTerms}
                />
              ) : (
                <ConversationList
                  aliasIndex={aliasIndex}
                  events={visibleThreadPage}
                  onEventClick={(eventId) => setModalState({ type: 'event', eventId })}
                  plainTextOnly={threadMode === 'chat'}
                  sortOrder={threadSort}
                  terms={modalTerms}
                />
              )}
              {visibleThread.length === 0 ? <p className="empty-state">No rows matched the current thread filter.</p> : null}
              {visibleThread.length > visibleThreadPage.length ? (
                <button
                  className="secondary-button load-more-button"
                  onClick={() => setModalThreadLimit((current) => current + THREAD_PAGE_SIZE)}
                  type="button"
                >
                  Load {Math.min(THREAD_PAGE_SIZE, visibleThread.length - visibleThreadPage.length)} more rows
                </button>
              ) : null}
            </div>
          </DetailModal>
        )
      }

      return (
        <DetailModal
          onClose={() => setModalState(null)}
          subtitle="Full thread view with every parsed row linked to this contact."
          title={summary.name}
        >
            <div className="modal-toolbar">
              <div className="button-row">
                <button className="ghost-button" onClick={() => moveModalContact(-1)} type="button">
                  Prev contact
                </button>
                <button className="ghost-button" onClick={() => moveModalContact(1)} type="button">
                  Next contact
                </button>
                <button className="secondary-button" onClick={() => setModalState({ type: 'thread-focus', contactName: summary.name })} type="button">
                  Chat focus
                </button>
                <button
                  className={reviewLaterContacts[summary.name] ? 'label-button active' : 'label-button'}
                  onClick={() => toggleReviewLater(summary.name)}
                  type="button"
                >
                  {reviewLaterContacts[summary.name] ? 'Saved' : 'Review later'}
                </button>
              </div>
              <div className="button-row">
                {(['male', 'female', 'unknown'] as ContactLabel[]).map((label) => (
                <button
                  className={
                    (contactLabels[summary.name] ?? 'unknown') === label
                      ? 'label-button active'
                      : 'label-button'
                  }
                  key={label}
                  onClick={() => setContactLabels((current) => ({ ...current, [summary.name]: label }))}
                  type="button"
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="modal-grid contact-modal-grid">
            <aside className="modal-aside">
              <article className="modal-card">
                <h4>Conversation profile</h4>
                <div className="score-row">
                  <ScorePill label="Flirt" value={summary.romanticScore} />
                  <ScorePill label="Secrecy" value={summary.secrecyScore} />
                  <ScorePill label="Intensity" value={summary.intensityScore} />
                </div>
                <ul className="fact-list tight">
                  <li>{summary.messageCount} chat rows across {summary.activeDays} active days.</li>
                  <li>{summary.searchCount} search rows and {summary.friendEventCount} friend rows.</li>
                  <li>
                    Peak time{' '}
                    {summary.peakHour !== null
                      ? `${summary.peakHour.toString().padStart(2, '0')}:00`
                      : 'Unknown'}{' '}
                    on {summary.peakWeekday ?? 'Unknown'}.
                  </li>
                  <li>Deletion indicators: {summary.deletionIndicators}.</li>
                  <li>First activity {formatDate(dateMarkers.find((marker) => marker.label === 'First activity')?.event.timestamp ?? null)}.</li>
                  <li>Last activity {formatDate(dateMarkers.find((marker) => marker.label === 'Last activity')?.event.timestamp ?? null)}.</li>
                  <li>First message {formatDate(dateMarkers.find((marker) => marker.label === 'First message')?.event.timestamp ?? null)}.</li>
                  <li>Last message {formatDate(dateMarkers.find((marker) => marker.label === 'Last message')?.event.timestamp ?? null)}.</li>
                  <li>Photo/video rows {mediaEvents.length}.</li>
                </ul>
              </article>
              <article className="modal-card">
                <h4>References</h4>
                <div className="entity-grid compact">
                  {contactEntities.map((entity) => (
                    <button
                      className="outline-pill clickable-pill"
                      key={entity.id}
                      onClick={() => {
                        setSearchQuery(entity.value)
                        setActiveTab('search')
                        setModalState(null)
                      }}
                      type="button"
                    >
                      {entity.type}: {entity.value}
                    </button>
                  ))}
                  {!contactEntities.length ? (
                    <p className="empty-state">No extracted entities for this contact.</p>
                  ) : null}
                </div>
              </article>
              <article className="modal-card">
                <h4>Patterns</h4>
                <div className="stack-list compact-stack">
                  {summary.topPhrases.map((phrase) => (
                    <button
                      className="outline-pill clickable-pill"
                      key={phrase}
                      onClick={() => setThreadSearch(phrase)}
                      type="button"
                    >
                      {phrase}
                    </button>
                  ))}
                  {contactHits.slice(0, 8).map((hit) => (
                    <button
                      className="outline-pill clickable-pill"
                      key={`${hit.eventId}-${hit.phrase}`}
                      onClick={() => setModalState({ type: 'event', eventId: hit.eventId })}
                      type="button"
                    >
                      {hit.category}: {hit.phrase}
                    </button>
                  ))}
                  {!summary.topPhrases.length && !contactHits.length ? (
                    <p className="empty-state">No repeated phrases or rule hits linked to this contact.</p>
                  ) : null}
                </div>
              </article>
            </aside>

            <section className="modal-main">
              <div className="thread-toolbar">
                <div className="button-row">
                  <button
                    className={threadSort === 'newest' ? 'tab-button active' : 'tab-button'}
                    onClick={() => setThreadSort('newest')}
                    type="button"
                  >
                    Newest first
                  </button>
                  <button
                    className={threadSort === 'oldest' ? 'tab-button active' : 'tab-button'}
                    onClick={() => setThreadSort('oldest')}
                    type="button"
                  >
                    Oldest first
                  </button>
                  <button
                    className={threadMode === 'chat' ? 'tab-button active' : 'tab-button'}
                    onClick={() => setThreadMode('chat')}
                    type="button"
                  >
                    Chat only
                  </button>
                  <button
                    className={threadMode === 'all' ? 'tab-button active' : 'tab-button'}
                    onClick={() => setThreadMode('all')}
                    type="button"
                  >
                    All linked rows
                  </button>
                </div>
                <div className="button-row">
                  <button className="ghost-button" onClick={handleDownloadSelectedTranscript} type="button">
                    Download TXT
                  </button>
                </div>
                <label className="search-field inline-search">
                  <span>Find inside thread</span>
                  <input
                    onChange={(event) => setThreadSearch(event.target.value)}
                    placeholder="Name, phrase, delete, address..."
                    type="search"
                    value={threadSearch}
                  />
                </label>
              </div>

              <div className="thread-scroll">
                {selectedPlatform === 'facebook' ? (
                  <FacebookConversationList
                    aliasIndex={aliasIndex}
                    events={visibleThreadPage}
                    onEventClick={(eventId) => setModalState({ type: 'event', eventId })}
                    sortOrder={threadSort}
                    terms={modalTerms}
                  />
                ) : (
                  <ConversationList
                    aliasIndex={aliasIndex}
                    events={visibleThreadPage}
                    onEventClick={(eventId) => setModalState({ type: 'event', eventId })}
                    plainTextOnly={threadMode === 'chat'}
                    sortOrder={threadSort}
                    terms={modalTerms}
                  />
                )}
                {visibleThread.length === 0 ? (
                  <p className="empty-state">No rows matched the current thread filter.</p>
                ) : null}
                {visibleThread.length > visibleThreadPage.length ? (
                  <button
                    className="secondary-button load-more-button"
                    onClick={() => setModalThreadLimit((current) => current + THREAD_PAGE_SIZE)}
                    type="button"
                  >
                    Load {Math.min(THREAD_PAGE_SIZE, visibleThread.length - visibleThreadPage.length)} more rows
                  </button>
                ) : null}
              </div>
            </section>
          </div>
        </DetailModal>
      )
    }

    if (modalState.type === 'event') {
      const event = eventsById.get(modalState.eventId)
      if (!event) return null

      return (
        <DetailModal
          onClose={() => setModalState(null)}
          subtitle={event.sourceFile}
          title={`Row ${event.id}`}
        >
          <div className="modal-grid two-column">
            <article className="modal-card">
              <h4>Observed values</h4>
              <ul className="fact-list tight">
                <li>Timestamp: {formatDate(event.timestamp)}</li>
                <li>Category: {event.category}</li>
                <li>Subtype: {event.subtype ?? 'Unknown'}</li>
                <li>Contact: {event.contact ?? 'Unknown'}</li>
                <li>Detail: {event.detail ?? 'None'}</li>
                <li>Location: {event.locationName ?? 'None'}</li>
                <li>Device: {event.device ?? 'None'}</li>
                <li>Region: {event.region ?? 'None'}</li>
              </ul>
            </article>
            <article className="modal-card">
              <h4>Full text</h4>
              <div className="transcript-stack">
                {renderTranscriptBlocks(event.text ?? event.detail ?? event.evidenceText, []) ?? (
                  <p className="raw-block">{eventSummaryText(event)}</p>
                )}
              </div>
              <h4>Raw fields</h4>
              <pre className="json-block">{JSON.stringify(event.attributes, null, 2)}</pre>
            </article>
          </div>
        </DetailModal>
      )
    }

    if (modalState.type === 'signal') {
      const signal = signalIndex.get(modalState.signalId)
      if (!signal) return null
      const evidence = signal.evidenceIds
        .map((eventId) => eventsById.get(eventId))
        .filter((event): event is NormalizedEvent => Boolean(event))

      return (
        <DetailModal
          onClose={() => setModalState(null)}
          subtitle={`${signal.type} / ${signal.severity} / score ${signal.score}`}
          title={signal.title}
        >
          <article className="modal-card">
            <p>{signal.summary}</p>
            <p className="section-copy">{signal.explanation}</p>
          </article>
          <div className="modal-list">
            {evidence.map((event) => (
              <button
                className="list-button"
                key={event.id}
                onClick={() => setModalState({ type: 'event', eventId: event.id })}
                type="button"
              >
                <div className="list-head">
                  <strong>{event.contact ?? event.category}</strong>
                  <span>{formatDate(event.timestamp)}</span>
                </div>
                <p>{compact(event.text ?? event.detail ?? event.evidenceText)}</p>
              </button>
            ))}
          </div>
        </DetailModal>
      )
    }

    if (modalState.type === 'upload') {
      const upload = uploadIndex.get(modalState.uploadId)
      const files = fileSummariesByUpload.get(modalState.uploadId) ?? []
      if (!upload) return null

      return (
        <DetailModal
          onClose={() => setModalState(null)}
          subtitle={upload.fileName}
          title="Upload details"
        >
          <div className="modal-grid two-column">
            <article className="modal-card">
              <h4>Upload summary</h4>
              <ul className="fact-list tight">
                <li>Size: {formatBytes(upload.sizeBytes)}</li>
                <li>Processed: {formatDate(upload.processedAt)}</li>
                <li>Supported files: {upload.supportedFiles}</li>
                <li>Skipped files: {upload.unsupportedFiles}</li>
                <li>Account: {upload.account.displayName ?? upload.account.username ?? 'Unknown'}</li>
                <li>Email: {upload.account.email ?? 'Unknown'}</li>
                <li>Phone: {upload.account.phone ?? 'Unknown'}</li>
              </ul>
            </article>
            <article className="modal-card">
              <h4>Files</h4>
              <div className="modal-list compact-stack">
                {files.map((file) => (
                  <button
                    className="list-button"
                    key={file.path}
                    onClick={() => setModalState({ type: 'file', path: file.path, uploadId: upload.id })}
                    type="button"
                  >
                    <div className="list-head">
                      <strong>{file.path}</strong>
                      <span>{file.rows} rows</span>
                    </div>
                    <p>
                      {file.category} / {file.supported ? 'supported' : 'skipped'}
                    </p>
                  </button>
                ))}
              </div>
            </article>
          </div>
        </DetailModal>
      )
    }

    if (modalState.type === 'file') {
      const file = workspace.fileSummaries.find(
        (entry) => entry.uploadId === modalState.uploadId && entry.path === modalState.path,
      )
      const fileEvents = workspace.events.filter(
        (event) => event.uploadId === modalState.uploadId && event.sourceFile === modalState.path,
      )
      if (!file) return null

      return (
        <DetailModal
          onClose={() => setModalState(null)}
          subtitle={`${file.category} / ${file.supported ? 'supported' : 'skipped'}`}
          title={file.path}
        >
          <article className="modal-card">
            <p>{file.rows} normalized rows recovered from this source file.</p>
          </article>
          <div className="modal-list">
            {fileEvents.map((event) => (
              <button
                className="list-button"
                key={event.id}
                onClick={() => setModalState({ type: 'event', eventId: event.id })}
                type="button"
              >
                <div className="list-head">
                  <strong>{event.contact ?? event.category}</strong>
                  <span>{formatDate(event.timestamp)}</span>
                </div>
                <p>{compact(event.text ?? event.detail ?? event.evidenceText)}</p>
              </button>
            ))}
            {fileEvents.length === 0 ? (
              <p className="empty-state">No normalized events were produced from this file.</p>
            ) : null}
          </div>
        </DetailModal>
      )
    }

    if (modalState.type === 'timeline') {
      const bucket = timelineBuckets.find((item) => item.key === modalState.dayKey)
      const events = scopedEvents.filter((event) => event.timestamp?.startsWith(modalState.dayKey))
      if (!bucket) return null

      return (
        <DetailModal
          onClose={() => setModalState(null)}
          subtitle={`${bucket.count} event${bucket.count === 1 ? '' : 's'}`}
          title={`Timeline detail for ${bucket.label}`}
        >
          <article className="modal-card">
            <div className="category-pills">
              {Object.entries(bucket.categories).map(([category, count]) => (
                <span className="outline-pill" key={category}>
                  {category}: {count}
                </span>
              ))}
            </div>
          </article>
          <div className="modal-list">
            {events.map((event) => (
              <button
                className="list-button"
                key={event.id}
                onClick={() => setModalState({ type: 'event', eventId: event.id })}
                type="button"
              >
                <div className="list-head">
                  <strong>{event.contact ?? event.category}</strong>
                  <span>{formatDate(event.timestamp)}</span>
                </div>
                <p>{compact(event.text ?? event.detail ?? event.evidenceText)}</p>
              </button>
            ))}
          </div>
        </DetailModal>
      )
    }

    return null
  }

  if (!selectedPlatform || platformPickerOpen) {
    return (
      <main className={`app-shell ${platformClass}`}>
        <section className="panel selector-panel">
          <div>
            <p className="eyebrow">Viewer selection</p>
            <h1>Choose a data viewer</h1>
            <p className="section-copy">
              Pick the platform first. The app will not load a workspace until you choose one.
            </p>
          </div>
          <div className="selector-grid">
            {(Object.entries(PLATFORM_CONFIG) as Array<[Platform, (typeof PLATFORM_CONFIG)[Platform]]>).map(
              ([platform, config]) => (
                <button
                  className={`selector-card ${lastPlatform === platform ? 'selector-card-active' : ''}`}
                  key={platform}
                  onClick={() => handlePlatformSelection(platform)}
                  type="button"
                >
                  <p className="eyebrow">{config.label}</p>
                  <h2>{config.heroTitle}</h2>
                  <p>{config.pickerCopy}</p>
                  <span className="outline-pill">
                    {lastPlatform === platform ? 'recently used' : 'start here'}
                  </span>
                </button>
              ),
            )}
          </div>
          {selectedPlatform ? (
            <div className="button-row">
              <button className="ghost-button" onClick={() => setPlatformPickerOpen(false)} type="button">
                Close selector
              </button>
            </div>
          ) : null}
        </section>
      </main>
    )
  }

  if (isLocked) {
    return (
      <main className={`app-shell ${platformClass}`}>
        <section className="panel lock-panel">
          <div>
            <p className="eyebrow">Private workspace lock</p>
            <h1>Unlock Export Viewer Pro</h1>
            <p className="section-copy">
              This is a local browser lock only. It protects this device session, not the public site itself.
            </p>
          </div>
          <div className="settings-grid">
            <label className="search-field">
              <span>Lock code</span>
              <input
                onChange={(event) => setUnlockDraft(event.target.value)}
                placeholder="Enter your lock code"
                type="password"
                value={unlockDraft}
              />
            </label>
          </div>
          <div className="button-row">
            <button className="primary-button" onClick={handleUnlock} type="button">
              Unlock
            </button>
            <button className="ghost-button" onClick={handleDisableLock} type="button">
              Remove local lock
            </button>
          </div>
          {error ? <p className="error-line">{error}</p> : null}
        </section>
      </main>
    )
  }

  return (
    <>
    <main className={`app-shell ${platformClass}`}>
      <header className="masthead">
          <div>
            <p className="eyebrow">Kali-style communication intelligence / {viewerConfig?.label}</p>
            <h1>{viewerConfig?.heroTitle ?? 'Export Viewer Pro'}</h1>
            <p className="section-copy">{viewerConfig?.heroCopy}</p>
          </div>
          <div className="masthead-actions">
            <label className="primary-button file-picker">
              <input accept=".zip" multiple onChange={handleZipUpload} type="file" />
              {isLoadingZip ? `Parsing ${viewerConfig?.label ?? ''} zip...` : `Upload ${viewerConfig?.label ?? ''} zip`}
            </label>
            <button className="secondary-button" onClick={() => folderInputRef.current?.click()} type="button">
              {isLoadingFolder ? `Parsing ${viewerConfig?.label ?? ''} folder...` : `Load extracted ${viewerConfig?.label ?? ''} folder`}
            </button>
            <button className="secondary-button" onClick={() => cacheInputRef.current?.click()} type="button">
              Load Python cache
            </button>
            <button
              className="ghost-button"
              onClick={() => viewerConfig && setUploads([viewerConfig.sampleUpload])}
              type="button"
            >
              Reset demo
            </button>
            <button className="ghost-button" onClick={() => void handleResetLocalWorkspace()} type="button">
              Clear saved
            </button>
            <button className="ghost-button" onClick={() => setPlatformPickerOpen(true)} type="button">
              Switch viewer
            </button>
            <input
              accept=".json"
              onChange={handleCacheUpload}
              ref={cacheInputRef}
              style={{ display: 'none' }}
              type="file"
            />
            <input
              ref={folderInputRef}
              multiple
              onChange={handleFolderUpload}
              style={{ display: 'none' }}
              type="file"
            />
          </div>
        </header>

        <section className="toolbar-panel">
          <div>
            <p>{status}</p>
            {error ? <p className="error-line">{error}</p> : null}
            {workspaceError ? <p className="error-line">{workspaceError}</p> : null}
            {isWorkspaceLoading ? <p className="loading-line">Loading contacts and thread rows...</p> : null}
            {(isWorkspaceLoading || isLoadingZip || isLoadingFolder || loadProgress.percent > 0) ? (
              <div className="page-progress-block">
                <div className="result-meta">
                  <span>{loadProgress.label || 'Working...'}</span>
                  <span>{Math.round(loadProgress.percent)}%</span>
                </div>
                <div className="progress-shell" aria-label="Processing progress">
                  <div className="progress-bar" style={{ width: `${clampPercent(loadProgress.percent)}%` }} />
                </div>
              </div>
            ) : null}
            {requiresAiForDeepReview && !aiSettings.apiKey.trim() ? (
              <p className="loading-line">
                Large export detected. The app will stay in lightweight mode until you open one contact and run AI on that thread.
              </p>
            ) : null}
            <div className="year-lens-strip">
              <label className="search-field">
                <span>Year</span>
                <select onChange={(event) => setYearFilter(event.target.value)} value={yearFilter}>
                  <option value="all">All years</option>
                  {availableYears.map((year) => (
                    <option key={year} value={year}>
                      {year}
                    </option>
                  ))}
                </select>
              </label>
              <label className="search-field">
                <span>Compare with</span>
                <select onChange={(event) => setComparisonYear(event.target.value)} value={comparisonYear}>
                  <option value="all">No compare</option>
                  {availableYears.map((year) => (
                    <option key={`compare-${year}`} value={year}>
                      {year}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="ghost-button"
                onClick={() => {
                  setYearFilter('all')
                  setComparisonYear('all')
                }}
                type="button"
              >
                Clear year lens
              </button>
            </div>
          </div>
          <div className="button-row">
            <span className="outline-pill">{isHydrating ? 'restoring local workspace...' : 'auto-save on'}</span>
            <button className="chip-button" onClick={() => downloadEventsJson(workspace.events)} type="button">
              Events JSON
            </button>
            <button className="chip-button" onClick={() => downloadContactsCsv(workspace.contacts)} type="button">
              Contacts CSV
            </button>
            <button className="chip-button" onClick={() => downloadKeywordHitsCsv(workspace.keywordHits)} type="button">
              Tone CSV
            </button>
            <button className="chip-button" onClick={() => downloadWorkspaceReport(workspace)} type="button">
              Report JSON
            </button>
          </div>
        </section>

        <section className="top-ai-panel">
          <div className="top-ai-copy">
            <p className="eyebrow">AI quick setup</p>
            <h2>Paste your key once</h2>
            <p className="section-copy">
              Default is the cheapest supported model path. Use AI only after you open one contact thread.
            </p>
            <div className="button-row">
              {MODEL_PRESETS[aiSettings.provider].map((model) => (
                <button
                  className={aiSettings.model === model ? 'label-button active' : 'label-button'}
                  key={model}
                  onClick={() => setAiSettings((current) => ({ ...current, model }))}
                  type="button"
                >
                  {model}
                </button>
              ))}
            </div>
          </div>
          <div className="top-ai-controls">
            <label className="search-field">
              <span>Provider</span>
              <select
                onChange={(event) =>
                  setAiSettings((current) => ({
                    ...current,
                    provider: event.target.value as AIProvider,
                    model:
                      current.provider === event.target.value
                        ? current.model
                        : DEFAULT_MODELS[event.target.value as AIProvider],
                  }))
                }
                value={aiSettings.provider}
              >
                <option value="gemini">Gemini</option>
                <option value="openai">OpenAI</option>
              </select>
            </label>
            <label className="search-field">
              <span>Model</span>
              <input
                onChange={(event) =>
                  setAiSettings((current) => ({ ...current, model: event.target.value }))
                }
                type="text"
                value={aiSettings.model}
              />
            </label>
            <label className="search-field top-ai-key">
              <span>API key</span>
              <input
                onChange={(event) =>
                  setAiSettings((current) => ({ ...current, apiKey: event.target.value }))
                }
                placeholder="Paste API key"
                type="password"
                value={aiSettings.apiKey}
              />
            </label>
            <button className="primary-button" onClick={handleAiRun} type="button">
              {isAiLoading ? 'Running AI...' : 'Run AI review'}
            </button>
          </div>
          <div className="top-ai-footer">
            <label className="search-field">
              <span>Local lock code</span>
              <input
                onChange={(event) => setLockDraft(event.target.value)}
                placeholder="4+ characters to lock this browser"
                type="password"
                value={lockDraft}
              />
            </label>
            <div className="button-row">
              <button className="secondary-button" onClick={handleSaveLockCode} type="button">
                Enable local lock
              </button>
              <button className="ghost-button" onClick={handleDisableLock} type="button">
                Remove lock
              </button>
            </div>
          </div>
        </section>

        <nav className="tab-bar" aria-label="Dashboard sections">
          {TAB_LABELS.map((tab) => (
            <button
              className={activeTab === tab.id ? 'tab-button active' : 'tab-button'}
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </nav>

        {activeTab === 'overview' ? (
          <>
            <section className="stats-grid">
              <MetricButton
                caption="All distinct contacts."
                label="People total"
                onClick={() => openMetricModal('contacts')}
                value={workspace.stats.uniqueContacts}
              />
              <MetricButton
                caption="Visible parsed chat rows."
                label="Chat rows"
                onClick={() => openMetricModal('threads')}
                value={workspace.stats.chatEvents}
              />
              <MetricButton
                caption="Search/friend rows with no chat thread."
                label="Missing threads"
                onClick={() => openMetricModal('missing')}
                value={workspace.stats.missingChatContacts}
              />
              <MetricButton
                caption="Delete, remove, clear, block, unsave."
                label="Deletion indicators"
                onClick={() => openMetricModal('deletions')}
                value={workspace.stats.deletionIndicators}
              />
              <MetricButton
                caption={`Peak day ${peakWeekdayLabel(workspace.weekdayBuckets)}`}
                label="Peak chat time"
                onClick={() => openMetricModal('timing')}
                value={peakHourLabel(workspace.hourBuckets)}
              />
              <MetricButton
                caption={`${workspace.stats.unsupportedFiles} skipped`}
                label="Supported files"
                onClick={() => openMetricModal('files')}
                value={workspace.stats.supportedFiles}
              />
            </section>

            <section className="dashboard-grid">
              <article className="panel year-compare-panel">
                <SectionHeader
                  eyebrow="Year lens"
                  subtitle={
                    yearComparison
                      ? `Comparing ${yearLabel(yearComparison.selectedYear)} against ${yearLabel(yearComparison.compareYear)}.`
                      : 'Choose a year and a comparison year to compare overlap, returns, and gaps.'
                  }
                  title="Year comparison"
                />
                {yearComparison ? (
                  <>
                    <div className="contact-summary-grid">
                      <article className="mini-stat">
                        <span>Selected year contacts</span>
                        <strong>{yearComparison.selectedCount}</strong>
                      </article>
                      <article className="mini-stat">
                        <span>Compare year contacts</span>
                        <strong>{yearComparison.compareCount}</strong>
                      </article>
                      <article className="mini-stat">
                        <span>Shared contacts</span>
                        <strong>{yearComparison.sharedCount}</strong>
                      </article>
                      <article className="mini-stat">
                        <span>Gap reappearances</span>
                        <strong>{yearComparison.reappeared.length}</strong>
                      </article>
                    </div>
                    <div className="stack-list compact-stack">
                      {yearComparison.reappeared.map((entry) => (
                        <button
                          className="list-button"
                          key={entry.contact}
                          onClick={() => openContactModal(entry.contact)}
                          type="button"
                        >
                          <div className="list-head">
                            <strong>{entry.contact}</strong>
                            <span>{entry.gap}-year gap</span>
                          </div>
                          <p>
                            Previous appearance {entry.previousYear}. Deletion indicators: {entry.deletionIndicators}.
                          </p>
                        </button>
                      ))}
                      {yearComparison.reappeared.length === 0 ? (
                        <p className="empty-state">No clear gap-based reappearances were detected in this comparison.</p>
                      ) : null}
                    </div>
                  </>
                ) : (
                  <p className="empty-state">Pick a year and an older year to compare contact overlap.</p>
                )}
              </article>
            </section>

            <section className="dashboard-grid">
              <article className="panel">
                <SectionHeader
                  eyebrow="Priority review"
                  subtitle="Contacts with the strongest combined intensity, secrecy, and romantic-tone scores."
                  title="Top contact priorities"
                />
                <div className="stack-list scroll-stack">
                  {priorityContacts.map((contact) => (
                    <button
                      className="list-button"
                      key={contact.name}
                      onClick={() => openContactModal(contact.name)}
                      type="button"
                    >
                      <div className="list-head">
                        <strong>{contact.name}</strong>
                        <span>
                          {contact.messageCount} chat rows
                          {yearFilter !== 'all'
                            ? ` · ${scopedContactCounts.get(contact.name) ?? 0} in ${yearLabel(selectedYearValue)}`
                            : ''}
                        </span>
                      </div>
                      <div className="score-row">
                        <ScorePill label="Flirt" value={contact.romanticScore} />
                        <ScorePill label="Secrecy" value={contact.secrecyScore} />
                        <ScorePill label="Intensity" value={contact.intensityScore} />
                      </div>
                    </button>
                  ))}
                </div>
              </article>

              <article className="panel">
                <SectionHeader
                  eyebrow="Uploads"
                  subtitle={`Use extracted-folder import for very large ${viewerConfig?.label.toLowerCase()} exports. It skips media and keeps the data pass responsive.`}
                  title="Loaded accounts and provenance"
                />
                <div className="stack-list scroll-stack">
                  {workspace.uploads.map((upload) => (
                    <button
                      className="list-button"
                      key={upload.id}
                      onClick={() => setModalState({ type: 'upload', uploadId: upload.id })}
                      type="button"
                    >
                      <div className="list-head">
                        <strong>{upload.fileName}</strong>
                        <span>{formatBytes(upload.sizeBytes)}</span>
                      </div>
                      <p>
                        {upload.account.displayName ?? upload.account.username ?? 'Unknown account'} / {upload.supportedFiles} supported files
                      </p>
                    </button>
                  ))}
                </div>
              </article>
            </section>

            <section className="dashboard-grid">
              <article className="panel">
                <SectionHeader eyebrow="Facts" title="Evidence-backed summary" />
                <ul className="fact-list">
                  {workspace.factsSummary.map((fact) => (
                    <li key={fact}>{fact}</li>
                  ))}
                </ul>
              </article>
              <article className="panel terminal-panel">
                <SectionHeader
                  eyebrow="Notes terminal"
                  subtitle="Local-only notes for follow-up questions, timestamps, or contact labels."
                  title="Working notes"
                />
                <textarea
                  className="notes-field"
                  onChange={(event) => setNotes(event.target.value)}
                  placeholder="$ note contacts, dates, questions, and follow-up checks"
                  value={notes}
                />
              </article>
            </section>
          </>
        ) : null}

        {activeTab === 'chats' ? (
          <section className={selectedPlatform === 'facebook' ? 'chat-layout facebook-workspace' : 'chat-layout'}>
            <article className="panel chat-sidebar" id="contact-browser">
              <SectionHeader
                actions={
                  <span className="outline-pill">
                    manual labels: {contactGroups.male}/{contactGroups.female}/{contactGroups.unknown}
                  </span>
                }
                eyebrow="Contact browser"
                subtitle={`Lightweight mode only indexes contacts and thread rows on load. Showing ${yearLabel(selectedYearValue)}.`}
                title="Contacts"
              />
              <div className="year-lens-strip chat-year-lens">
                <label className="search-field">
                  <span>Year</span>
                  <select onChange={(event) => setYearFilter(event.target.value)} value={yearFilter}>
                    <option value="all">All years</option>
                    {availableYears.map((year) => (
                      <option key={year} value={year}>
                        {year}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="search-field">
                  <span>Compare with</span>
                  <select onChange={(event) => setComparisonYear(event.target.value)} value={comparisonYear}>
                    <option value="all">No compare</option>
                    {availableYears.map((year) => (
                      <option key={`chat-compare-${year}`} value={year}>
                        {year}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="ghost-button"
                  onClick={() => {
                    setYearFilter('all')
                    setComparisonYear('all')
                  }}
                  type="button"
                >
                  Reset
                </button>
              </div>
              <div className="filter-grid">
                <label className="search-field">
                  <span>Search</span>
                  <input
                    onChange={(event) => setContactSearch(event.target.value)}
                    placeholder="Find contact..."
                    type="search"
                    value={contactSearch}
                  />
                </label>
                <label className="search-field">
                  <span>Sort</span>
                  <select value={contactSort} onChange={(event) => setContactSort(event.target.value as ContactSort)}>
                    <option value="activity">Activity</option>
                    <option value="messages">Messages</option>
                    <option value="romance">Flirt score</option>
                    <option value="secrecy">Secrecy score</option>
                    <option value="recent">Recent shift</option>
                    <option value="missing">Missing threads</option>
                  </select>
                </label>
              </div>
              <div className="group-tabs">
                <button className={contactGroupFilter === 'all' ? 'tab-button active' : 'tab-button'} onClick={() => setContactGroupFilter('all')} type="button">
                  All ({workspace.contacts.length})
                </button>
                <button className={contactGroupFilter === 'male' ? 'tab-button active' : 'tab-button'} onClick={() => setContactGroupFilter('male')} type="button">
                  Male ({contactGroups.male})
                </button>
                <button className={contactGroupFilter === 'female' ? 'tab-button active' : 'tab-button'} onClick={() => setContactGroupFilter('female')} type="button">
                  Female ({contactGroups.female})
                </button>
                <button className={contactGroupFilter === 'unknown' ? 'tab-button active' : 'tab-button'} onClick={() => setContactGroupFilter('unknown')} type="button">
                  Unlabeled ({contactGroups.unknown})
                </button>
              </div>
              <div className="subpanel compact-subpanel">
                <div className="thread-header-row">
                  <h3>Review later</h3>
                  <div className="button-row">
                    <button className="ghost-button" onClick={handleDownloadReviewLaterContacts} type="button">
                      Export CSV
                    </button>
                  </div>
                </div>
                <div className="stack-list compact-stack review-strip">
                  {reviewLaterQueue.length ? (
                    reviewLaterQueue.slice(0, 6).map((contact) => (
                      <button
                        className="list-button"
                        key={contact.name}
                        onClick={() => {
                          setSelectedContact(contact.name)
                          setThreadSearch('')
                          setThreadMode('chat')
                        }}
                        type="button"
                      >
                        <div className="list-head">
                          <strong>{contact.name}</strong>
                          <span>{formatDate(contact.lastSeen)}</span>
                        </div>
                        <p>
                          Last file: {contact.lastSourceFile ?? 'Unknown'} · {contact.selfMessageCount} from you / {contact.contactMessageCount} from them
                        </p>
                      </button>
                    ))
                  ) : (
                    <p className="empty-state">No contacts saved for later review yet.</p>
                  )}
                </div>
              </div>
              <div className="contact-table">
                {filteredContacts.map((contact) => (
                  <div
                    className={selectedSummary?.name === contact.name ? 'contact-row active' : 'contact-row'}
                    key={contact.name}
                  >
                    <button
                      className="contact-row-body"
                      onClick={() => {
                        setSelectedContact(contact.name)
                        setThreadSearch('')
                        setThreadMode('chat')
                      }}
                      type="button"
                    >
                      <div className="contact-row-main">
                        <strong>{contact.name}</strong>
                        <span>
                          {contact.messageCount} chat rows
                          {yearFilter !== 'all'
                            ? ` · ${scopedContactCounts.get(contact.name) ?? 0} in ${yearLabel(selectedYearValue)}`
                            : ''}
                        </span>
                      </div>
                      <div className="contact-row-meta">
                        <ScorePill label="Flirt" value={contact.romanticScore} />
                        <ScorePill label="S" value={contact.secrecyScore} />
                        <ScorePill label="I" value={contact.intensityScore} />
                      </div>
                      <p className="contact-row-foot">
                        Last contact {formatDate(contact.lastSeen)} · File {contact.lastSourceFile ?? 'Unknown'}
                      </p>
                    </button>
                    <div className="contact-row-actions">
                      <button
                        className={reviewLaterContacts[contact.name] ? 'label-button active' : 'label-button'}
                        onClick={() => toggleReviewLater(contact.name)}
                        type="button"
                      >
                        {reviewLaterContacts[contact.name] ? 'Saved' : 'Review later'}
                      </button>
                    </div>
                  </div>
                ))}
                {filteredContacts.length === 0 ? (
                  <p className="empty-state">No contacts matched the current filter.</p>
                ) : null}
              </div>
            </article>

            <article className="panel chat-preview-panel">
              {selectedSummary ? (
                <>
                  <div className="facebook-thread-stack">
                    <SectionHeader
                      actions={
                        selectedSummary ? (
                          <div className="button-row">
                            <button
                              className="ghost-button"
                              onClick={() => {
                                setActiveTab('chats')
                                window.requestAnimationFrame(() => {
                                  document.getElementById('contact-browser')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                                })
                              }}
                              type="button"
                            >
                              Back to people
                            </button>
                            <button
                              className={reviewLaterContacts[selectedSummary.name] ? 'label-button active' : 'label-button'}
                              onClick={() => toggleReviewLater(selectedSummary.name)}
                              type="button"
                            >
                              {reviewLaterContacts[selectedSummary.name] ? 'Saved' : 'Review later'}
                            </button>
                            <button className="primary-button" onClick={() => openContactModal(selectedSummary.name)} type="button">
                              Open full thread
                            </button>
                          </div>
                        ) : null
                      }
                      eyebrow="Selected contact"
                      subtitle={`Facebook Messenger layout showing ${yearLabel(selectedYearValue)}. Click a contact to load the transcript, dates, and trace log.`}
                      title={selectedSummary?.name ?? 'Choose a Facebook thread'}
                    />

                    <div className="contact-summary-grid">
                      <article className="mini-stat">
                        <span>Linked rows</span>
                        <strong>{selectedThread.length}</strong>
                      </article>
                      <article className="mini-stat">
                        <span>Messages</span>
                        <strong>{selectedThreadMessageCount}</strong>
                      </article>
                      <article className="mini-stat">
                        <span>From you</span>
                        <strong>{selectedSummary.selfMessageCount}</strong>
                      </article>
                      <article className="mini-stat">
                        <span>From them</span>
                        <strong>{selectedSummary.contactMessageCount}</strong>
                      </article>
                      <article className="mini-stat">
                        <span>Media you sent</span>
                        <strong>{selectedSummary.selfMediaCount}</strong>
                      </article>
                      <article className="mini-stat">
                        <span>Media they sent</span>
                        <strong>{selectedSummary.contactMediaCount}</strong>
                      </article>
                      <article className="mini-stat">
                        <span>Last contact</span>
                        <strong>{formatThreadTimestamp(selectedSummary.lastSeen ?? null)}</strong>
                      </article>
                      <article className="mini-stat">
                        <span>Last file</span>
                        <strong>{selectedSummary.lastSourceFile ?? 'Unknown'}</strong>
                      </article>
                      <article className="mini-stat">
                        <span>Latest sent</span>
                        <strong>{formatThreadTimestamp(selectedThreadLatestEvent?.timestamp ?? null)}</strong>
                      </article>
                      <article className="mini-stat">
                        <span>Oldest sent</span>
                        <strong>{formatThreadTimestamp(selectedThreadOldestEvent?.timestamp ?? null)}</strong>
                      </article>
                      <article className="mini-stat">
                        <span>First message</span>
                        <strong>{formatDay(selectedMarkerMap['First message']?.timestamp ?? null)}</strong>
                      </article>
                      <article className="mini-stat">
                        <span>Last message</span>
                        <strong>{formatDay(selectedMarkerMap['Last message']?.timestamp ?? null)}</strong>
                      </article>
                      <article className="mini-stat">
                        <span>Year coverage</span>
                        <strong>{selectedContactYears.length ? selectedContactYears.join(', ') : 'Unknown'}</strong>
                      </article>
                      <article className="mini-stat">
                        <span>Gaps &gt;1y</span>
                        <strong>{selectedContactYearGaps.length}</strong>
                      </article>
                    </div>

                    <div className="score-row">
                      <ScorePill label="Flirt" value={selectedSummary.romanticScore} />
                      <ScorePill label="Secrecy" value={selectedSummary.secrecyScore} />
                      <ScorePill label="Intensity" value={selectedSummary.intensityScore} />
                    </div>

                    <div className="button-row">
                      {(['male', 'female', 'unknown'] as ContactLabel[]).map((label) => (
                        <button
                          className={(contactLabels[selectedSummary.name] ?? 'unknown') === label ? 'label-button active' : 'label-button'}
                          key={label}
                          onClick={() => setContactLabels((current) => ({ ...current, [selectedSummary.name]: label }))}
                          type="button"
                        >
                          {label}
                        </button>
                      ))}
                      <button className="secondary-button" onClick={() => openContactFocusModal(selectedSummary.name)} type="button">
                        Chat focus
                      </button>
                      <button className="secondary-button" onClick={handleSelectedContactAiRun} type="button">
                        {isContactAiLoading ? 'AI organizing...' : 'Organize with AI'}
                      </button>
                      <button className="ghost-button" onClick={handleDownloadSelectedTranscript} type="button">
                        Download TXT
                      </button>
                      <button className="ghost-button" onClick={handleDownloadSelectedTranscriptHtml} type="button">
                        Download HTML
                      </button>
                    </div>

                    <article className="subpanel">
                      <div className="thread-header-row">
                        <div>
                          <h3>Thread intelligence</h3>
                          <p className="section-copy">
                            Runs only on the selected contact thread using the cheapest configured model.
                          </p>
                        </div>
                        <span className="outline-pill">
                          {aiSettings.provider} / {aiSettings.model}
                        </span>
                      </div>
                      <div className="score-row">
                        <span className="outline-pill">{selectedThread.length} linked rows</span>
                        <span className="outline-pill">{selectedThreadTokenEstimate.toLocaleString()} est. tokens</span>
                        <span className="outline-pill">{selectedThreadChunkEstimate} AI chunk{selectedThreadChunkEstimate === 1 ? '' : 's'}</span>
                      </div>
                      {contactAiError ? <p className="error-line">{contactAiError}</p> : null}
                      {isContactAiLoading ? (
                        <div className="ai-progress-card">
                          <div className="result-meta">
                            <span>{contactAiProgress.label || 'Organizing selected thread'}</span>
                            <span>{contactAiProgressPercent.toFixed(0)}%</span>
                          </div>
                          <div className="progress-shell" aria-label="AI progress">
                            <div className="progress-bar" style={{ width: `${contactAiProgressPercent}%` }} />
                          </div>
                        </div>
                      ) : null}
                      {selectedContactAiResult ? (
                        <div className="ai-result">
                          <div className="result-meta">
                            <span>{selectedContactAiResult.provider}</span>
                            <span>{formatDate(selectedContactAiResult.createdAt)}</span>
                          </div>
                          <p className="raw-block">{selectedContactAiResult.answer}</p>
                        </div>
                      ) : (
                        <p className="empty-state">
                          No selected-thread AI result yet. Open a contact and run AI to organize that one thread only.
                        </p>
                      )}
                    </article>

                    <article className="subpanel">
                      <div className="thread-header-row">
                        <h3>Parsed thread</h3>
                        <div className="button-row">
                          <button
                            className={threadSort === 'newest' ? 'tab-button active' : 'tab-button'}
                            onClick={() => setThreadSort('newest')}
                            type="button"
                          >
                            Newest first
                          </button>
                          <button
                            className={threadSort === 'oldest' ? 'tab-button active' : 'tab-button'}
                            onClick={() => setThreadSort('oldest')}
                            type="button"
                          >
                            Oldest first
                          </button>
                          <button
                            className={threadMode === 'chat' ? 'tab-button active' : 'tab-button'}
                            onClick={() => setThreadMode('chat')}
                            type="button"
                          >
                            Chat only
                          </button>
                          <button
                            className={threadMode === 'all' ? 'tab-button active' : 'tab-button'}
                            onClick={() => setThreadMode('all')}
                            type="button"
                          >
                            All linked rows
                          </button>
                        </div>
                      </div>
                      <label className="search-field inline-search">
                        <span>Find inside this thread</span>
                        <input
                          onChange={(event) => setThreadSearch(event.target.value)}
                          placeholder="Name, phrase, address, delete..."
                          type="search"
                          value={threadSearch}
                        />
                      </label>
                      <div className="thread-scroll main-thread-scroll">
                        {selectedPlatform === 'facebook' ? (
                          <FacebookConversationList
                            aliasIndex={aliasIndex}
                            events={selectedVisibleThreadPage}
                            onEventClick={(eventId) => setModalState({ type: 'event', eventId })}
                            sortOrder={threadSort}
                            terms={selectedThreadTerms}
                          />
                        ) : (
                          <ConversationList
                            aliasIndex={aliasIndex}
                            events={selectedVisibleThreadPage}
                            onEventClick={(eventId) => setModalState({ type: 'event', eventId })}
                            plainTextOnly={threadMode === 'chat'}
                            sortOrder={threadSort}
                            terms={selectedThreadTerms}
                          />
                        )}
                        {selectedVisibleThread.length === 0 ? (
                          <p className="empty-state">No parsed rows matched this thread view.</p>
                        ) : null}
                        {selectedVisibleThread.length > selectedVisibleThreadPage.length ? (
                          <button
                            className="secondary-button load-more-button"
                            onClick={() => setSelectedThreadLimit((current) => current + THREAD_PAGE_SIZE)}
                            type="button"
                          >
                            Load {Math.min(THREAD_PAGE_SIZE, selectedVisibleThread.length - selectedVisibleThreadPage.length)} more rows
                          </button>
                        ) : null}
                      </div>
                    </article>
                  </div>

                  <aside className="facebook-data-stack">
                    <SectionHeader
                      eyebrow="Data log"
                      subtitle="Recovered dates, evidence gaps, and return traces from the Facebook export."
                      title="Message history and traces"
                    />
                    <div className="detail-duo-grid">
                      <article className="subpanel">
                        <h3>First and last markers</h3>
                        <div className="stack-list compact-stack">
                          {selectedDateMarkers.map((marker) => (
                            <button
                              className="list-button"
                              key={`${marker.label}-${marker.event.id}`}
                              onClick={() => setModalState({ type: 'event', eventId: marker.event.id })}
                              type="button"
                            >
                              <div className="list-head">
                                <strong>{marker.label}</strong>
                                <span>{formatDate(marker.event.timestamp)}</span>
                              </div>
                              <p>{eventSummaryText(marker.event)}</p>
                            </button>
                          ))}
                          {selectedDateMarkers.length === 0 ? (
                            <p className="empty-state">No dated rows were recovered for this contact.</p>
                          ) : null}
                        </div>
                      </article>

                      <article className="subpanel">
                        <h3>Photo and media dates</h3>
                        <div className="entity-grid compact">
                          {selectedSourceFiles.map((source) => (
                            <span className="outline-pill" key={source}>
                              {source}
                            </span>
                          ))}
                        </div>
                        <div className="stack-list compact-stack media-stack">
                          {selectedMediaEvents.map((event) => (
                            <button
                              className="list-button"
                              key={event.id}
                              onClick={() => setModalState({ type: 'event', eventId: event.id })}
                              type="button"
                            >
                              <div className="list-head">
                                <strong>{formatDate(event.timestamp)}</strong>
                                <span>{event.category}</span>
                              </div>
                              <p>{eventSummaryText(event)}</p>
                            </button>
                          ))}
                          {selectedMediaEvents.length === 0 ? (
                            <p className="empty-state">No contact-linked photo or media rows were recovered from the current export.</p>
                          ) : null}
                        </div>
                      </article>
                    </div>

                    <article className="subpanel">
                      <h3>Missing thread candidates</h3>
                      <div className="stack-list compact-stack">
                        {missingChatContacts.slice(0, 5).map((contact) => (
                          <button
                            className="list-button"
                            key={contact.name}
                            onClick={() => openContactModal(contact.name)}
                            type="button"
                          >
                            <div className="list-head">
                              <strong>{contact.name}</strong>
                              <span>{contact.searchCount} search / {contact.friendEventCount} friend</span>
                            </div>
                            <p>No chat rows were recovered for this contact.</p>
                          </button>
                        ))}
                        {missingChatContacts.length === 0 ? (
                          <p className="empty-state">No missing-thread contacts detected.</p>
                        ) : null}
                      </div>
                    </article>

                    <article className="subpanel">
                      <h3>Deletion and return traces</h3>
                      <div className="stack-list compact-stack">
                        {yearComparison?.reappeared.slice(0, 5).map((entry) => (
                          <button
                            className="list-button"
                            key={`${entry.contact}-${entry.previousYear}`}
                            onClick={() => openContactModal(entry.contact)}
                            type="button"
                          >
                            <div className="list-head">
                              <strong>{entry.contact}</strong>
                              <span>gap {entry.gap} year(s)</span>
                            </div>
                            <p>
                              Reappeared in {yearComparison.selectedYear} after last being seen in {entry.previousYear}.{' '}
                              {entry.deletionIndicators > 0 ? `${entry.deletionIndicators} deletion cue(s) in the contact trace.` : 'No direct deletion cue was parsed.'}
                            </p>
                          </button>
                        ))}
                        {yearComparison && yearComparison.reappeared.length === 0 ? (
                          <p className="empty-state">No gap-based reappearances were detected for the selected comparison.</p>
                        ) : null}
                        {!yearComparison ? (
                          <p className="empty-state">Pick a selected year and comparison year to surface return traces.</p>
                        ) : null}
                      </div>
                    </article>
                  </aside>
                </>
              ) : (
                <p className="empty-state">Choose a Facebook contact to load the message thread and data log.</p>
              )}
            </article>
          </section>
        ) : null}

        {activeTab === 'search' ? (
          <section className="dashboard-grid">
            <article className="panel">
              <SectionHeader
                eyebrow="Reference search"
                subtitle="Search names, handles, words, or phrases across all parsed rows. Multiple terms are supported with commas or new lines."
                title="Keyword and name finder"
              />
              <label className="search-field">
                <span>Terms</span>
                <textarea
                  className="keyword-box"
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Jordan, address, delete this, hotel"
                  value={searchQuery}
                />
              </label>
              <div className="result-meta">
                <span>{searchHits.length} matching row(s)</span>
                <span>{searchTerms.length} active term(s)</span>
              </div>
              <div className="stack-list scroll-stack medium-scroll">
                {searchHits.map((event) => (
                  <button
                    className="list-button"
                    key={event.id}
                    onClick={() => setModalState({ type: 'event', eventId: event.id })}
                    type="button"
                  >
                    <div className="list-head">
                      <strong>{event.contact ?? event.category}</strong>
                      <span>{formatDate(event.timestamp)}</span>
                    </div>
                    <p>
                      <HighlightedText
                        terms={searchTerms}
                        text={compact(event.text ?? event.detail ?? event.evidenceText)}
                      />
                    </p>
                    <span className="mono">{event.sourceFile}</span>
                  </button>
                ))}
                {searchTerms.length === 0 ? <p className="empty-state">Enter one or more search terms.</p> : null}
                {searchTerms.length > 0 && searchHits.length === 0 ? (
                  <p className="empty-state">No rows matched the current terms.</p>
                ) : null}
              </div>
            </article>

            <article className="panel">
              <SectionHeader
                eyebrow="Structured references"
                subtitle="Click an entity or phrase to push it into the search view immediately."
                title="Entities and repeated phrases"
              />
              <div className="subpanel">
                <h3>Entities</h3>
                <div className="stack-list scroll-stack short-scroll">
                  {workspace.entities.slice(0, 18).map((entity) => (
                    <button
                      className="list-button"
                      key={entity.id}
                      onClick={() => setSearchQuery(entity.value)}
                      type="button"
                    >
                      <div className="list-head">
                        <strong>{entity.value}</strong>
                        <span>{entity.type}</span>
                      </div>
                      <p>{entity.count} mention(s) across {entity.contacts.length} contact(s).</p>
                    </button>
                  ))}
                </div>
              </div>
              <div className="subpanel">
                <h3>Repeated phrases</h3>
                <div className="entity-grid compact">
                  {workspace.repeatedPhrases.map((phrase) => (
                    <button
                      className="outline-pill clickable-pill"
                      key={phrase.phrase}
                      onClick={() => setSearchQuery(phrase.phrase)}
                      type="button"
                    >
                      {phrase.phrase} ({phrase.count})
                    </button>
                  ))}
                  {workspace.repeatedPhrases.length === 0 ? (
                    <p className="empty-state">No repeated phrases above threshold.</p>
                  ) : null}
                </div>
              </div>
            </article>
          </section>
        ) : null}

        {activeTab === 'signals' ? (
          <section className="dashboard-grid">
            <article className="panel">
              <SectionHeader
                eyebrow="Signals"
                subtitle="Deterministic findings only. Click any card to inspect the linked evidence."
                title="Findings"
              />
              <div className="stack-list scroll-stack medium-scroll">
                {workspace.signals.map((signal) => (
                  <button
                    className="signal-button"
                    key={signal.id}
                    onClick={() => setModalState({ type: 'signal', signalId: signal.id })}
                    type="button"
                  >
                    <div className="list-head">
                      <strong>{signal.title}</strong>
                      <span className={`score-pill score-${signal.severity}`}>{signal.severity}</span>
                    </div>
                    <p>{signal.summary}</p>
                    <span>{signal.explanation}</span>
                  </button>
                ))}
              </div>
            </article>

            <article className="panel">
              <SectionHeader
                eyebrow="Timeline"
                subtitle="Click a day to inspect all rows in that period."
                title="Notable periods and event clusters"
              />
              <div className="timeline-chart compact-chart">
                {timelineBuckets.slice(-21).map((bucket) => (
                  <button
                    className="timeline-bar button-bar"
                    key={bucket.key}
                    onClick={() => setModalState({ type: 'timeline', dayKey: bucket.key })}
                    type="button"
                  >
                    <div
                      className="timeline-fill"
                      style={{
                        height: `${Math.max(
                          10,
                          (bucket.count / Math.max(...timelineBuckets.map((item) => item.count), 1)) * 100,
                        )}%`,
                      }}
                    />
                    <strong>{bucket.count}</strong>
                    <span>{bucket.label}</span>
                  </button>
                ))}
              </div>
              <div className="subpanel">
                <h3>Deletion / removal rows</h3>
                <div className="stack-list scroll-stack short-scroll">
                  {deletionEvents.map((event) => (
                    <button
                      className="list-button"
                      key={event.id}
                      onClick={() => setModalState({ type: 'event', eventId: event.id })}
                      type="button"
                    >
                      <div className="list-head">
                        <strong>{event.contact ?? event.category}</strong>
                        <span>{formatDay(event.timestamp)}</span>
                      </div>
                      <p>{compact(event.text ?? event.detail ?? event.evidenceText)}</p>
                    </button>
                  ))}
                  {deletionEvents.length === 0 ? <p className="empty-state">No deletion indicators detected.</p> : null}
                </div>
              </div>
            </article>
          </section>
        ) : null}

        {activeTab === 'ai' ? (
          <section className="dashboard-grid">
            <article className="panel">
              <SectionHeader
                eyebrow="AI setup"
                subtitle="Optional. Keys stay in session storage and deterministic analytics still work without AI."
                title="Provider and model"
              />
              <div className="settings-grid">
                <label>
                  <span>Provider</span>
                  <select
                    onChange={(event) =>
                      setAiSettings((current) => ({
                        ...current,
                        provider: event.target.value as AIProvider,
                        model:
                          current.provider === event.target.value
                            ? current.model
                            : DEFAULT_MODELS[event.target.value as AIProvider],
                      }))
                    }
                    value={aiSettings.provider}
                  >
                    <option value="gemini">Gemini</option>
                    <option value="openai">OpenAI</option>
                  </select>
                </label>
                <label>
                  <span>Model</span>
                  <input
                    onChange={(event) =>
                      setAiSettings((current) => ({ ...current, model: event.target.value }))
                    }
                    type="text"
                    value={aiSettings.model}
                  />
                </label>
                <label className="span-two">
                  <span>API key</span>
                  <input
                    onChange={(event) =>
                      setAiSettings((current) => ({ ...current, apiKey: event.target.value }))
                    }
                    placeholder="Paste API key"
                    type="password"
                    value={aiSettings.apiKey}
                  />
                </label>
                <label className="span-two">
                  <span>Analysis prompt</span>
                  <textarea
                    className="ai-prompt"
                    onChange={(event) => setAiQuestion(event.target.value)}
                    value={aiQuestion}
                  />
                </label>
              </div>
              <div className="hero-pills">
                {MODEL_PRESETS[aiSettings.provider].map((model) => (
                  <button
                    className={aiSettings.model === model ? 'chip-button active-chip' : 'chip-button'}
                    key={model}
                    onClick={() => setAiSettings((current) => ({ ...current, model }))}
                    type="button"
                  >
                    {model}
                  </button>
                ))}
              </div>
              <button className="primary-button full-width" onClick={handleAiRun} type="button">
                {isAiLoading ? 'Analyzing full chat history...' : 'Run AI over full chat history'}
              </button>
              {aiError ? <p className="error-line">{aiError}</p> : null}
            </article>

            <article className="panel">
              <SectionHeader
                eyebrow="AI output"
                subtitle="The model receives deterministic context plus chunked chat history and must cite evidence IDs."
                title="Analysis result"
              />
              {aiResult ? (
                <article className="ai-result">
                  <div className="list-head">
                    <strong>
                      {aiResult.provider} / {aiResult.model}
                    </strong>
                    <span>{formatDate(aiResult.createdAt)}</span>
                  </div>
                  <p className="ai-question">{aiResult.question}</p>
                  <pre>{aiResult.answer}</pre>
                </article>
              ) : (
                <p className="empty-state">No AI analysis has been run yet.</p>
              )}
            </article>
          </section>
        ) : null}

        {activeTab === 'data' ? (
          <section className="dashboard-grid">
            <article className="panel">
              <SectionHeader
                eyebrow="Export coverage"
                subtitle="Supported text-based export areas currently recognized by the parser."
                title="Categories"
              />
              <div className="hero-pills">
                {(viewerConfig?.supportedAreas ?? []).map((label) => (
                  <span className="outline-pill" key={label}>
                    {label}
                  </span>
                ))}
              </div>
              <div className="subpanel">
                <h3>Warnings</h3>
                <div className="stack-list compact-stack">
                  {workspace.warnings.map((warning) => (
                    <article className="list-card" key={warning}>
                      <p>{warning}</p>
                    </article>
                  ))}
                  {workspace.warnings.length === 0 ? <p className="empty-state">No parser warnings.</p> : null}
                </div>
              </div>
            </article>

            <article className="panel">
              <SectionHeader
                eyebrow="Files"
                subtitle="Every file is clickable so you can inspect the normalized rows recovered from it."
                title="Source files"
              />
              <div className="stack-list scroll-stack medium-scroll">
                {workspace.fileSummaries.map((file) => (
                  <button
                    className="list-button"
                    key={`${file.uploadId}-${file.path}`}
                    onClick={() => setModalState({ type: 'file', path: file.path, uploadId: file.uploadId })}
                    type="button"
                  >
                    <div className="list-head">
                      <strong>{file.path}</strong>
                      <span>{file.rows} rows</span>
                    </div>
                    <p>
                      {file.category} / {file.supported ? 'supported' : 'skipped'}
                    </p>
                  </button>
                ))}
              </div>
            </article>
          </section>
        ) : null}
      </main>
      {renderModal()}
    </>
  )
}
