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
import type {
  AIProvider,
  AIResult,
  AISettings,
  ContactSummary,
  FileSummary,
  NormalizedEvent,
  ParsedUpload,
  UploadSummary,
  WorkspaceDataset,
} from './types'
import { runAIReview, runContactAIReview } from './lib/ai'
import {
  downloadContactsCsv,
  downloadEventsJson,
  downloadKeywordHitsCsv,
  downloadWorkspaceReport,
} from './lib/exporters'
import { buildWorkspaceLite } from './lib/insights'
import { clearSnapshot, loadSnapshot, saveSnapshot } from './lib/persistence'
import { parseSnapchatFileList, parseSnapchatZip } from './lib/snapchatParser'
import { sampleUpload } from './sampleData'

type ContactLabel = 'male' | 'female' | 'unknown'
type ActiveTab = 'overview' | 'chats' | 'search' | 'signals' | 'ai' | 'data'
type ContactSort = 'activity' | 'messages' | 'romance' | 'secrecy' | 'recent' | 'missing'
type ThreadMode = 'chat' | 'all'
type MetricKey = 'contacts' | 'threads' | 'missing' | 'deletions' | 'timing' | 'files'

type ModalState =
  | { type: 'contact'; contactName: string }
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
const LOCK_CODE_KEY = 'export-viewer-pro-lock-code'
const DEFAULT_MODELS: Record<AIProvider, string> = {
  gemini: 'gemini-2.5-flash-lite',
  openai: 'gpt-5-nano',
}
const MODEL_PRESETS: Record<AIProvider, string[]> = {
  gemini: ['gemini-2.5-flash-lite', 'gemini-2.5-flash'],
  openai: ['gpt-5-nano'],
}
const SUPPORTED_EXPORT_AREAS = [
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
]
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
  'Organize this selected thread into a factual timeline, interaction patterns, tone categories, repeated names or references, and open follow-up checks with evidence IDs.'

function estimateTokenCount(events: NormalizedEvent[]) {
  const joined = events
    .map((event) => [event.timestamp, event.contact, event.text ?? event.detail ?? event.evidenceText].filter(Boolean).join(' '))
    .join('\n')

  return Math.max(0, Math.ceil(joined.length / 4))
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, value))
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
    /\b(function|const|let|var|return|document\.|window\.|querySelector)\b/.test(normalized)

  if (looksStructured) {
    try {
      const parsed = JSON.parse(normalized) as Record<string, unknown>
      const candidate = ['message', 'text', 'body', 'content', 'caption', 'savedchat']
        .map((key) => parsed[key])
        .find((entry) => typeof entry === 'string' && entry.trim())

      if (typeof candidate === 'string') {
        return preserveBodyText(candidate)
      }
    } catch {
      return ''
    }
    return ''
  }

  return preserveBodyText(plain)
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
  const primary = preserveBodyText(event.text)
  if (primary) {
    return primary
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
  return formatPlainConversationText(event.text)
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

function extractActorValue(event: NormalizedEvent) {
  const keys = ['sender', 'from', 'author', 'participant', 'display_name', 'user', 'username']
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
}) {
  return (
    <div className="conversation-list">
      {props.events.map((event, index) => {
        const dayKey = event.timestamp?.slice(0, 10) ?? `undated-${event.id}`
        const previousDayKey =
          props.events[index - 1]?.timestamp?.slice(0, 10) ?? `undated-${props.events[index - 1]?.id ?? 'start'}`
        const showDay = index === 0 || dayKey !== previousDayKey
        const role = resolveConversationRole(event, props.aliasIndex)

        const displayText = props.plainTextOnly ? eventConversationText(event) : eventSummaryText(event)

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
                <span className="message-actor">
                  {extractActorValue(event) ?? (role === 'self' ? 'You' : event.contact ?? 'Unknown')}
                </span>
                <span className="message-copy">
                  <HighlightedText
                    terms={props.terms}
                    text={displayText || (props.plainTextOnly ? 'No readable chat text was recovered for this row.' : eventSummaryText(event))}
                  />
                </span>
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
}) {
  return (
    <div className="modal-backdrop" onClick={props.onClose} role="presentation">
      <section
        aria-modal="true"
        className="modal-shell"
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
  const [uploads, setUploads] = useState([sampleUpload])
  const [workspace, setWorkspace] = useState<WorkspaceDataset>(() => buildWorkspaceLite([sampleUpload]))
  const [isHydrating, setIsHydrating] = useState(true)
  const [status, setStatus] = useState('Demo workspace loaded. Upload a zip or extracted export folder.')
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
  const [selectedContact, setSelectedContact] = useState('')
  const [contactLabels, setContactLabels] = useState<Record<string, ContactLabel>>({})
  const [contactGroupFilter, setContactGroupFilter] = useState<'all' | ContactLabel>('all')
  const [searchQuery, setSearchQuery] = useState('delete this, Jordan, address')
  const [threadMode, setThreadMode] = useState<ThreadMode>('chat')
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
    'Review the full chat history and summarize the strongest factual patterns, tone shifts, deletion indicators, and missing-thread gaps with evidence IDs.',
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

  const deferredContactSearch = useDeferredValue(contactSearch)
  const deferredSearchQuery = useDeferredValue(searchQuery)
  const deferredThreadSearch = useDeferredValue(threadSearch)

  useEffect(() => {
    folderInputRef.current?.setAttribute('webkitdirectory', '')
    folderInputRef.current?.setAttribute('directory', '')
    setNotes(window.localStorage.getItem(NOTES_KEY) ?? '')
    const storedLabels = window.localStorage.getItem(CONTACT_LABELS_KEY)
    const storedSettings = window.sessionStorage.getItem(AI_SETTINGS_KEY)
    const storedLockCode = window.localStorage.getItem(LOCK_CODE_KEY)
    if (storedLabels) {
      try {
        setContactLabels(JSON.parse(storedLabels) as Record<string, ContactLabel>)
      } catch {
        window.localStorage.removeItem(CONTACT_LABELS_KEY)
      }
    }
    if (storedSettings) {
      try {
        setAiSettings(JSON.parse(storedSettings) as AISettings)
      } catch {
        window.sessionStorage.removeItem(AI_SETTINGS_KEY)
      }
    }
    setIsLocked(Boolean(storedLockCode))

    void loadSnapshot()
      .then((snapshot) => {
        if (!snapshot?.uploads?.length) return
        setUploads(snapshot.uploads)
        setContactAiResults(snapshot.contactAiResults ?? {})
        setStatus(`Restored ${snapshot.uploads.length} saved upload(s) from this browser.`)
      })
      .catch(() => {
        setStatus('Demo workspace loaded. Upload a zip or extracted export folder.')
      })
      .finally(() => setIsHydrating(false))
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

  useEffect(() => window.localStorage.setItem(NOTES_KEY, notes), [notes])
  useEffect(
    () => window.localStorage.setItem(CONTACT_LABELS_KEY, JSON.stringify(contactLabels)),
    [contactLabels],
  )
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
    if (isHydrating) return

    void saveSnapshot({
      uploads: uploads as ParsedUpload[],
      contactAiResults,
      savedAt: new Date().toISOString(),
    }).catch(() => {
      setWorkspaceError('Local workspace persistence failed. The dashboard will keep working for this session.')
    })
  }, [contactAiResults, isHydrating, uploads])
  useEffect(() => {
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
  }, [uploads])
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
  const uploadIndex = useMemo(
    () => new Map(workspace.uploads.map((upload) => [upload.id, upload])),
    [workspace.uploads],
  )
  const aliasIndex = useMemo(() => buildAliasIndex(workspace.uploads), [workspace.uploads])
  const signalIndex = useMemo(
    () => new Map(workspace.signals.map((signal) => [signal.id, signal])),
    [workspace.signals],
  )
  const eventsByContact = useMemo(() => {
    const map = new Map<string, NormalizedEvent[]>()
    workspace.events.forEach((event) => {
      if (!event.contact) return
      const current = map.get(event.contact) ?? []
      current.push(event)
      map.set(event.contact, current)
    })
    return map
  }, [workspace.events])
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
    if (!workspace.contacts.length) {
      setSelectedContact('')
      return
    }

    if (!workspace.contacts.some((contact) => contact.name === selectedContact)) {
      setSelectedContact(workspace.contacts[0].name)
    }
  }, [selectedContact, workspace.contacts])
  useEffect(() => {
    setSelectedThreadLimit(THREAD_PAGE_SIZE)
  }, [selectedContact, threadMode])
  useEffect(() => {
    setModalThreadLimit(THREAD_PAGE_SIZE)
  }, [modalState, threadMode])

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

  const selectedSummary =
    contactIndex.get(selectedContact) ?? filteredContacts[0] ?? workspace.contacts[0] ?? null

  const selectedThread = useMemo(() => {
    if (!selectedSummary) return []
    return eventsByContact.get(selectedSummary.name) ?? []
  }, [eventsByContact, selectedSummary])

  const selectedVisibleThread = useMemo(() => {
    const threadTerms = queryTermsFromInput(deferredThreadSearch)
    return selectedThread.filter((event) => {
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
  }, [deferredThreadSearch, selectedThread, threadMode])
  const selectedThreadTerms = useMemo(
    () => queryTermsFromInput(deferredThreadSearch),
    [deferredThreadSearch],
  )
  const selectedVisibleThreadPage = useMemo(
    () => selectedVisibleThread.slice(0, selectedThreadLimit),
    [selectedThreadLimit, selectedVisibleThread],
  )

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
  const contactAiProgressPercent = useMemo(
    () => clampPercent((contactAiProgress.completed / Math.max(contactAiProgress.total, 1)) * 100),
    [contactAiProgress],
  )

  const searchTerms = useMemo(() => queryTermsFromInput(deferredSearchQuery), [deferredSearchQuery])
  const searchHits = useMemo(() => {
    if (!searchTerms.length) return []

    return workspace.events
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
  }, [searchTerms, workspace.events])

  const deletionEvents = useMemo(
    () => workspace.events.filter((event) => hasDeletionIndicator(event)),
    [workspace.events],
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
  const requiresAiForDeepReview = workspace.stats.totalEvents >= LARGE_EXPORT_THRESHOLD

  function mergeUploads(nextUploads: typeof uploads) {
    setUploads((current) => {
      const base = current.length === 1 && current[0].upload.id === sampleUpload.upload.id ? [] : current
      return [...base, ...nextUploads]
    })
  }

  async function handleZipUpload(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])]
    if (!files.length) return
    setIsLoadingZip(true)
    setError(null)
    setLoadProgress({ percent: 0, label: 'Opening zip export...' })
    setStatus(`Parsing ${files.length} zip upload${files.length === 1 ? '' : 's'}...`)

    try {
      const parsed: ParsedUpload[] = []

      for (const [index, file] of files.entries()) {
        const upload = await parseSnapchatZip(file, (progress) => {
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
    const files = [...(event.target.files ?? [])]
    if (!files.length) return
    setIsLoadingFolder(true)
    setError(null)
    setLoadProgress({ percent: 0, label: 'Scanning extracted export folder...' })
    setStatus('Parsing extracted export folder and skipping media...')

    try {
      const parsed = await parseSnapchatFileList(files, setLoadProgress)
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
    await clearSnapshot()
    setUploads([sampleUpload])
    setContactAiResults({})
    setAiResult(null)
    setSelectedContact('')
    setStatus('Local workspace cleared. Demo workspace loaded.')
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

  function moveModalContact(direction: -1 | 1) {
    if (!modalState || modalState.type !== 'contact') return
    const names = (filteredContacts.length ? filteredContacts : workspace.contacts).map((contact) => contact.name)
    const index = names.indexOf(modalState.contactName)
    if (index < 0) return
    const nextName = names[(index + direction + names.length) % names.length]
    setSelectedContact(nextName)
    setThreadSearch('')
    setModalState({ type: 'contact', contactName: nextName })
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
                  Intensity {contact.intensityScore}/10, secrecy {contact.secrecyScore}/10, romance {contact.romanticScore}/10
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

    if (modalState.type === 'contact') {
      const summary = contactIndex.get(modalState.contactName)
      if (!summary) return null
      const thread = eventsByContact.get(summary.name) ?? []
      const dateMarkers = buildDateMarkers(thread)
      const mediaEvents = thread.filter((event) => isMediaEvent(event))
      const modalTerms = queryTermsFromInput(deferredThreadSearch)
      const visibleThread = thread.filter((event) => {
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
                  <ScorePill label="Romance" value={summary.romanticScore} />
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
                <ConversationList
                  aliasIndex={aliasIndex}
                  events={visibleThreadPage}
                  onEventClick={(eventId) => setModalState({ type: 'event', eventId })}
                  plainTextOnly={threadMode === 'chat'}
                  terms={modalTerms}
                />
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
              <p className="raw-block">{eventSummaryText(event)}</p>
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
      const bucket = workspace.timeline.find((item) => item.key === modalState.dayKey)
      const events = workspace.events.filter((event) => event.timestamp?.startsWith(modalState.dayKey))
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

  if (isLocked) {
    return (
      <main className="app-shell">
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
      <main className="app-shell">
        <header className="masthead">
          <div>
            <p className="eyebrow">Kali-style communication intelligence</p>
            <h1>Export Viewer Pro</h1>
            <p className="section-copy">
              Compact dashboard for Snapchat export review with click-through threads, entity
              search, timing analysis, and optional AI summarization.
            </p>
          </div>
          <div className="masthead-actions">
            <label className="primary-button file-picker">
              <input accept=".zip" multiple onChange={handleZipUpload} type="file" />
              {isLoadingZip ? 'Parsing zip...' : 'Upload zip'}
            </label>
            <button className="secondary-button" onClick={() => folderInputRef.current?.click()} type="button">
              {isLoadingFolder ? 'Parsing folder...' : 'Load extracted folder'}
            </button>
            <button className="secondary-button" onClick={() => cacheInputRef.current?.click()} type="button">
              Load Python cache
            </button>
            <button className="ghost-button" onClick={() => setUploads([sampleUpload])} type="button">
              Reset demo
            </button>
            <button className="ghost-button" onClick={() => void handleResetLocalWorkspace()} type="button">
              Clear saved
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
                        <span>{contact.messageCount} chat rows</span>
                      </div>
                      <div className="score-row">
                        <ScorePill label="Romance" value={contact.romanticScore} />
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
                  subtitle="Use extracted-folder import for very large exports. It skips media and keeps the data pass responsive."
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
          <section className="chat-layout">
            <article className="panel chat-sidebar">
              <SectionHeader
                actions={
                  <span className="outline-pill">
                    manual labels: {contactGroups.male}/{contactGroups.female}/{contactGroups.unknown}
                  </span>
                }
                eyebrow="Contact browser"
                subtitle="Lightweight mode only indexes contacts and thread rows on load. Open one contact and run AI only when needed."
                title="Contacts"
              />
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
                    <option value="romance">Romance score</option>
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
              <div className="contact-table">
                {filteredContacts.map((contact) => (
                  <button
                    className={selectedSummary?.name === contact.name ? 'contact-row active' : 'contact-row'}
                    key={contact.name}
                    onClick={() => {
                      setSelectedContact(contact.name)
                      setThreadSearch('')
                      setThreadMode('chat')
                    }}
                    type="button"
                  >
                    <div className="contact-row-main">
                      <strong>{contact.name}</strong>
                      <span>{contact.messageCount} chat rows</span>
                    </div>
                    <div className="contact-row-meta">
                      <ScorePill label="R" value={contact.romanticScore} />
                      <ScorePill label="S" value={contact.secrecyScore} />
                      <ScorePill label="I" value={contact.intensityScore} />
                    </div>
                  </button>
                ))}
                {filteredContacts.length === 0 ? (
                  <p className="empty-state">No contacts matched the current filter.</p>
                ) : null}
              </div>
            </article>

            <article className="panel chat-preview-panel">
              <SectionHeader
                actions={
                  selectedSummary ? (
                    <button className="primary-button" onClick={() => openContactModal(selectedSummary.name)} type="button">
                      Open full thread
                    </button>
                  ) : null
                }
                eyebrow="Selected contact"
                subtitle="Click a contact to load the full parsed thread here. Every row stays clickable for raw detail."
                title={selectedSummary?.name ?? 'Choose a contact'}
              />
              {selectedSummary ? (
                <>
                  <div className="contact-summary-grid">
                    <article className="mini-stat">
                      <span>Linked rows</span>
                      <strong>{selectedThread.length}</strong>
                    </article>
                    <article className="mini-stat">
                      <span>Messages</span>
                      <strong>{selectedSummary.messageCount}</strong>
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
                      <span>First activity</span>
                      <strong>{formatDay(selectedMarkerMap['First activity']?.timestamp ?? null)}</strong>
                    </article>
                    <article className="mini-stat">
                      <span>Last activity</span>
                      <strong>{formatDay(selectedMarkerMap['Last activity']?.timestamp ?? null)}</strong>
                    </article>
                  </div>

                  <div className="score-row">
                    <ScorePill label="Romance" value={selectedSummary.romanticScore} />
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
                    <button className="secondary-button" onClick={handleSelectedContactAiRun} type="button">
                      {isContactAiLoading ? 'AI organizing...' : 'Organize with AI'}
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
                      <ConversationList
                        aliasIndex={aliasIndex}
                        events={selectedVisibleThreadPage}
                        onEventClick={(eventId) => setModalState({ type: 'event', eventId })}
                        plainTextOnly={threadMode === 'chat'}
                        terms={selectedThreadTerms}
                      />
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
                </>
              ) : (
                <p className="empty-state">No contact selected.</p>
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
                {workspace.timeline.slice(-21).map((bucket) => (
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
                          (bucket.count / Math.max(...workspace.timeline.map((item) => item.count), 1)) * 100,
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
                {SUPPORTED_EXPORT_AREAS.map((label) => (
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
