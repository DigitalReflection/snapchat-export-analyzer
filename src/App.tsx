import { startTransition, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import './App.css'
import type { AIProvider, AIResult, AISettings, ContactSummary, NormalizedEvent } from './types'
import { runAIReview } from './lib/ai'
import {
  downloadContactsCsv,
  downloadEventsJson,
  downloadKeywordHitsCsv,
  downloadWorkspaceReport,
} from './lib/exporters'
import { buildWorkspace } from './lib/insights'
import { parseSnapchatFileList, parseSnapchatZip } from './lib/snapchatParser'
import { sampleUpload } from './sampleData'

type ContactLabel = 'male' | 'female' | 'unknown'

const NOTES_KEY = 'export-viewer-pro-private-notes'
const AI_SETTINGS_KEY = 'export-viewer-pro-ai-settings'
const CONTACT_LABELS_KEY = 'export-viewer-pro-contact-labels'
const DEFAULT_MODELS: Record<AIProvider, string> = {
  gemini: 'gemini-2.5-pro',
  openai: 'gpt-5.1',
}
const MODEL_PRESETS: Record<AIProvider, string[]> = {
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  openai: ['gpt-5.1', 'gpt-5-mini'],
}
const SUPPORTED_EXPORT_AREAS = [
  'Profiles',
  'Saved chats',
  'Snap history',
  'Friends',
  'Search',
  'Location',
  'Login/device',
  'Memories',
  'HTML/CSV/TXT',
]

function formatDate(value: string | null) {
  if (!value) return 'Unknown'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString()
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

function peakHour(events: NormalizedEvent[]) {
  const buckets = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    count: events.filter((event) => event.timestamp && new Date(event.timestamp).getHours() === hour)
      .length,
  })).sort((left, right) => right.count - left.count)
  return buckets[0]?.count ? `${buckets[0].hour}:00` : 'Unknown'
}

function peakWeekday(events: NormalizedEvent[]) {
  const labels = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const buckets = labels.map((label, day) => ({
    label,
    count: events.filter((event) => event.timestamp && new Date(event.timestamp).getDay() === day)
      .length,
  })).sort((left, right) => right.count - left.count)
  return buckets[0]?.count ? buckets[0].label : 'Unknown'
}

function keywordsFromInput(value: string) {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
}

function SectionHeader(props: { eyebrow: string; title: string; subtitle?: string }) {
  return (
    <div className="section-heading">
      <p className="eyebrow">{props.eyebrow}</p>
      <h2>{props.title}</h2>
      {props.subtitle ? <p className="section-copy">{props.subtitle}</p> : null}
    </div>
  )
}

function ContactItem(props: {
  contact: ContactSummary
  active: boolean
  label: ContactLabel
  onClick: () => void
}) {
  return (
    <button className={props.active ? 'contact-item active' : 'contact-item'} onClick={props.onClick} type="button">
      <div>
        <strong>{props.contact.name}</strong>
        <span>{props.contact.interactions} events</span>
      </div>
      <span className={`contact-label label-${props.label}`}>{props.label}</span>
    </button>
  )
}

export default function App() {
  const [uploads, setUploads] = useState([sampleUpload])
  const [status, setStatus] = useState('Demo workspace loaded. Upload a zip or extracted export folder.')
  const [error, setError] = useState<string | null>(null)
  const [isLoadingZip, setIsLoadingZip] = useState(false)
  const [isLoadingFolder, setIsLoadingFolder] = useState(false)
  const [notes, setNotes] = useState('')
  const [contactSearch, setContactSearch] = useState('')
  const [selectedContact, setSelectedContact] = useState('')
  const [contactLabels, setContactLabels] = useState<Record<string, ContactLabel>>({})
  const [contactGroupFilter, setContactGroupFilter] = useState<'all' | ContactLabel>('all')
  const [keywordQuery, setKeywordQuery] = useState('delete this, keep this between us')
  const [aiSettings, setAiSettings] = useState<AISettings>({ provider: 'gemini', apiKey: '', model: DEFAULT_MODELS.gemini })
  const [aiQuestion, setAiQuestion] = useState('Review the full chat history and summarize the strongest factual patterns with evidence IDs.')
  const [aiResult, setAiResult] = useState<AIResult | null>(null)
  const [aiError, setAiError] = useState<string | null>(null)
  const [isAiLoading, setIsAiLoading] = useState(false)
  const folderInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    folderInputRef.current?.setAttribute('webkitdirectory', '')
    folderInputRef.current?.setAttribute('directory', '')
    setNotes(window.localStorage.getItem(NOTES_KEY) ?? '')
    const storedLabels = window.localStorage.getItem(CONTACT_LABELS_KEY)
    const storedSettings = window.sessionStorage.getItem(AI_SETTINGS_KEY)
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
  }, [])

  useEffect(() => window.localStorage.setItem(NOTES_KEY, notes), [notes])
  useEffect(() => window.localStorage.setItem(CONTACT_LABELS_KEY, JSON.stringify(contactLabels)), [contactLabels])
  useEffect(() => window.sessionStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(aiSettings)), [aiSettings])

  const workspace = useMemo(() => buildWorkspace(uploads), [uploads])
  useEffect(() => {
    if (workspace.contacts.length && !workspace.contacts.some((contact) => contact.name === selectedContact)) {
      setSelectedContact(workspace.contacts[0].name)
    }
  }, [selectedContact, workspace.contacts])

  const chatEvents = useMemo(() => workspace.events.filter((event) => event.category === 'chat'), [workspace.events])
  const filteredContacts = useMemo(() => {
    const needle = contactSearch.trim().toLowerCase()
    return workspace.contacts.filter((contact) => {
      const label = contactLabels[contact.name] ?? 'unknown'
      if (contactGroupFilter !== 'all' && label !== contactGroupFilter) return false
      return !needle || contact.name.toLowerCase().includes(needle)
    })
  }, [contactGroupFilter, contactLabels, contactSearch, workspace.contacts])
  const contactGroups = useMemo(
    () => ({
      male: workspace.contacts.filter((contact) => (contactLabels[contact.name] ?? 'unknown') === 'male').length,
      female: workspace.contacts.filter((contact) => (contactLabels[contact.name] ?? 'unknown') === 'female').length,
      unknown: workspace.contacts.filter((contact) => (contactLabels[contact.name] ?? 'unknown') === 'unknown').length,
    }),
    [contactLabels, workspace.contacts],
  )
  const selectedSummary = workspace.contacts.find((contact) => contact.name === selectedContact) ?? null
  const selectedThread = workspace.events.filter((event) => event.contact === selectedContact)
  const selectedToneHits = workspace.keywordHits.filter((hit) => hit.contact === selectedContact)
  const selectedEntities = workspace.entities.filter((entity) => entity.contacts.includes(selectedContact)).slice(0, 8)
  const keywordHits = useMemo(() => {
    const keywords = keywordsFromInput(keywordQuery)
    return workspace.events
      .filter((event) => event.category === 'chat' && event.text)
      .flatMap((event) =>
        keywords
          .filter((keyword) => event.text?.toLowerCase().includes(keyword))
          .map((keyword) => ({ keyword, event })),
      )
  }, [keywordQuery, workspace.events])

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
    setStatus(`Parsing ${files.length} zip upload${files.length === 1 ? '' : 's'}...`)
    try {
      const parsed = await Promise.all(files.map((file) => parseSnapchatZip(file)))
      startTransition(() => mergeUploads(parsed))
      setStatus(`Loaded ${parsed.reduce((sum, upload) => sum + upload.events.length, 0)} normalized events from zip upload(s).`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Zip parsing failed.')
      setStatus('Zip parsing failed.')
    } finally {
      setIsLoadingZip(false)
      event.target.value = ''
    }
  }

  async function handleFolderUpload(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])]
    if (!files.length) return
    setIsLoadingFolder(true)
    setError(null)
    setStatus('Parsing extracted export folder and skipping media...')
    try {
      const parsed = await parseSnapchatFileList(files)
      startTransition(() => mergeUploads([parsed]))
      setStatus(`Loaded extracted folder ${parsed.upload.fileName} and skipped media files.`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Folder parsing failed.')
      setStatus('Folder parsing failed.')
    } finally {
      setIsLoadingFolder(false)
      event.target.value = ''
    }
  }

  async function handleAiRun() {
    setIsAiLoading(true)
    setAiError(null)
    try {
      setAiResult(await runAIReview(aiSettings, workspace, aiQuestion))
    } catch (caught) {
      setAiError(caught instanceof Error ? caught.message : 'AI analysis failed.')
    } finally {
      setIsAiLoading(false)
    }
  }

  return (
    <main className="app-shell">
      <header className="masthead">
        <div>
          <p className="eyebrow">Kali-style communication intelligence</p>
          <h1>Export Viewer Pro</h1>
          <p className="section-copy">Chat-first dashboard for Snapchat exports with thread browsing, keyword search, time analysis, and optional AI review.</p>
        </div>
        <div className="masthead-actions">
          <label className="primary-button file-picker"><input accept=".zip" multiple onChange={handleZipUpload} type="file" />{isLoadingZip ? 'Parsing zip...' : 'Upload zip'}</label>
          <button className="secondary-button" onClick={() => folderInputRef.current?.click()} type="button">{isLoadingFolder ? 'Parsing folder...' : 'Load extracted folder'}</button>
          <button className="ghost-button" onClick={() => setUploads([sampleUpload])} type="button">Reset demo</button>
          <input ref={folderInputRef} multiple onChange={handleFolderUpload} style={{ display: 'none' }} type="file" />
        </div>
      </header>

      <section className="overview-grid">
        <article className="panel hero-panel">
          <SectionHeader eyebrow="Overview" title="Visible controls, high-limit import path" subtitle="Use extracted-folder import for very large Snapchat exports. It skips photos and videos and only scans text-based export data." />
          <div className="hero-pills">{SUPPORTED_EXPORT_AREAS.map((label) => <span className="outline-pill" key={label}>{label}</span>)}</div>
          <div className="hero-status"><p>{status}</p>{error ? <p className="error-line">{error}</p> : null}</div>
          <div className="button-row">
            <button className="chip-button" onClick={() => downloadEventsJson(workspace.events)} type="button">Events JSON</button>
            <button className="chip-button" onClick={() => downloadContactsCsv(workspace.contacts)} type="button">Contacts CSV</button>
            <button className="chip-button" onClick={() => downloadKeywordHitsCsv(workspace.keywordHits)} type="button">Tone CSV</button>
            <button className="chip-button" onClick={() => downloadWorkspaceReport(workspace)} type="button">Report JSON</button>
          </div>
        </article>
        <article className="panel ai-setup-panel">
          <SectionHeader eyebrow="AI setup" title="API key and provider are here" subtitle="Keys stay in session storage. AI review is optional and deterministic analytics still run without it." />
          <div className="settings-grid">
            <label><span>Provider</span><select value={aiSettings.provider} onChange={(event) => setAiSettings((current) => ({ ...current, provider: event.target.value as AIProvider, model: current.provider === event.target.value ? current.model : DEFAULT_MODELS[event.target.value as AIProvider] }))}><option value="gemini">Gemini</option><option value="openai">OpenAI</option></select></label>
            <label><span>Model</span><input type="text" value={aiSettings.model} onChange={(event) => setAiSettings((current) => ({ ...current, model: event.target.value }))} /></label>
            <label className="span-two"><span>API key</span><input type="password" placeholder="Paste API key" value={aiSettings.apiKey} onChange={(event) => setAiSettings((current) => ({ ...current, apiKey: event.target.value }))} /></label>
            <label className="span-two"><span>AI request</span><textarea className="ai-prompt" value={aiQuestion} onChange={(event) => setAiQuestion(event.target.value)} /></label>
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
          <button className="primary-button full-width" onClick={handleAiRun} type="button">{isAiLoading ? 'Analyzing full chat history...' : 'Run AI over full chat history'}</button>
          {aiError ? <p className="error-line">{aiError}</p> : null}
        </article>
      </section>

      <section className="stats-grid">
        <article className="stat-card"><span>Peak chat time</span><strong>{peakHour(chatEvents)}</strong><p>Chat events only.</p></article>
        <article className="stat-card"><span>Peak chat day</span><strong>{peakWeekday(chatEvents)}</strong><p>Chat events only.</p></article>
        <article className="stat-card"><span>Most active contact</span><strong>{workspace.contacts[0]?.name ?? 'Unknown'}</strong><p>{workspace.contacts[0]?.interactions ?? 0} events.</p></article>
        <article className="stat-card"><span>Total events</span><strong>{workspace.stats.totalEvents}</strong><p>{workspace.stats.uniqueEntities} extracted entities.</p></article>
        <article className="stat-card"><span>Supported files</span><strong>{workspace.fileSummaries.filter((file) => file.supported).length}</strong><p>{workspace.fileSummaries.filter((file) => !file.supported).length} skipped.</p></article>
        <article className="stat-card"><span>Highest signal</span><strong>{workspace.signals[0]?.title ?? 'None'}</strong><p>{workspace.signals[0]?.summary ?? 'No deterministic alerts.'}</p></article>
      </section>

      <section className="dashboard-grid">
        <article className="panel panel-span-two">
          <SectionHeader eyebrow="Upload/account overview" title="Source provenance and account metadata" />
          <div className="upload-grid">{workspace.uploads.map((upload) => <article className="upload-card" key={upload.id}><div className="upload-head"><div><strong>{upload.fileName}</strong><span>{formatBytes(upload.sizeBytes)}</span></div><span className="outline-pill">{upload.supportedFiles} supported files</span></div><div className="meta-grid"><span>Processed {formatDate(upload.processedAt)}</span><span>Account {upload.account.displayName ?? upload.account.username ?? 'Unknown'}</span><span>{upload.account.email ?? 'No email recovered'}</span><span>{upload.account.phone ?? 'No phone recovered'}</span></div></article>)}</div>
        </article>
        <article className="panel"><SectionHeader eyebrow="Facts-only summary" title="Core facts" /><ul className="fact-list">{workspace.factsSummary.map((fact) => <li key={fact}>{fact}</li>)}</ul></article>
        <article className="panel terminal-panel"><SectionHeader eyebrow="Notes terminal" title="Local notes" subtitle="Styled like a terminal window and kept in local storage." /><textarea className="notes-field" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="$ write notes about contacts, times, and follow-up questions" /></article>
      </section>

      <section className="chat-explorer-grid">
        <article className="panel contact-browser">
          <SectionHeader eyebrow="Chat explorer" title="Switch contacts and view full threads" subtitle="Male / female grouping is a manual organizer stored on this device. The app does not infer gender from names or messages." />
          <div className="group-tabs">
            <button className={contactGroupFilter === 'all' ? 'tab-button active' : 'tab-button'} onClick={() => setContactGroupFilter('all')} type="button">All ({workspace.contacts.length})</button>
            <button className={contactGroupFilter === 'male' ? 'tab-button active' : 'tab-button'} onClick={() => setContactGroupFilter('male')} type="button">Male ({contactGroups.male})</button>
            <button className={contactGroupFilter === 'female' ? 'tab-button active' : 'tab-button'} onClick={() => setContactGroupFilter('female')} type="button">Female ({contactGroups.female})</button>
            <button className={contactGroupFilter === 'unknown' ? 'tab-button active' : 'tab-button'} onClick={() => setContactGroupFilter('unknown')} type="button">Unlabeled ({contactGroups.unknown})</button>
          </div>
          <label className="search-field"><span>Search contacts</span><input type="search" value={contactSearch} onChange={(event) => setContactSearch(event.target.value)} placeholder="Find contact..." /></label>
          <div className="contact-list">{filteredContacts.map((contact) => <ContactItem active={selectedContact === contact.name} contact={contact} key={contact.name} label={contactLabels[contact.name] ?? 'unknown'} onClick={() => setSelectedContact(contact.name)} />)}{filteredContacts.length === 0 ? <p className="empty-state">No contacts matched the current filters.</p> : null}</div>
        </article>
        <article className="panel thread-panel">
          <SectionHeader eyebrow="Selected thread" title={selectedContact || 'Choose a contact'} subtitle="All parsed rows linked to this contact, organized cleanly for reading and switching." />
          {selectedSummary ? (
            <>
              <div className="profile-toolbar">
                <div className="label-buttons">{(['male', 'female', 'unknown'] as ContactLabel[]).map((label) => <button className={(contactLabels[selectedSummary.name] ?? 'unknown') === label ? 'label-button active' : 'label-button'} key={label} onClick={() => setContactLabels((current) => ({ ...current, [selectedSummary.name]: label }))} type="button">{label}</button>)}</div>
                <div className="toolbar-meta"><span>Peak hour {peakHour(selectedThread.filter((event) => event.category === 'chat'))}</span><span>Peak day {peakWeekday(selectedThread.filter((event) => event.category === 'chat'))}</span></div>
              </div>
              <div className="contact-profile-grid">
                <article className="profile-card"><h3>Profile facts</h3><ul className="fact-list tight"><li>{selectedSummary.interactions} linked events across {selectedSummary.activeDays} active day(s).</li><li>{selectedSummary.messageCount} chat messages and {selectedSummary.searchCount} related search event(s).</li><li>First seen {formatDate(selectedSummary.firstSeen)} and last seen {formatDate(selectedSummary.lastSeen)}.</li><li>Tone labels: {selectedSummary.topToneLabels.join(', ') || 'none'}.</li></ul></article>
                <article className="profile-card"><h3>References</h3><div className="entity-grid compact">{selectedEntities.map((entity) => <span className="outline-pill" key={entity.id}>{entity.type}: {entity.value}</span>)}{selectedEntities.length === 0 ? <p className="empty-state">No structured references extracted for this contact.</p> : null}</div></article>
                <article className="profile-card"><h3>Deterministic tone hits</h3><div className="tone-list">{selectedToneHits.map((hit) => <span className="outline-pill" key={`${hit.eventId}-${hit.phrase}`}>{hit.category}: {hit.phrase}</span>)}{selectedToneHits.length === 0 ? <p className="empty-state">No deterministic tone rules matched this contact.</p> : null}</div></article>
              </div>
              <div className="thread-view">{selectedThread.map((event) => <article className="message-card" key={event.id}><div className="message-meta"><span className="message-type">{event.category}</span><span>{formatDate(event.timestamp)}</span></div><p>{compact(event.text ?? event.detail ?? event.locationName ?? event.evidenceText) || 'No visible text for this row.'}</p><span className="mono">[{event.id}] {event.sourceFile}</span></article>)}</div>
            </>
          ) : <p className="empty-state">No contact selected.</p>}
        </article>
      </section>

      <section className="dashboard-grid">
        <article className="panel"><SectionHeader eyebrow="Keyword finder" title="Search your own keywords or phrases" subtitle="Type comma-separated phrases to see every chat match." /><label className="search-field"><span>Keywords / phrases</span><textarea className="keyword-box" value={keywordQuery} onChange={(event) => setKeywordQuery(event.target.value)} /></label><div className="stack-list">{keywordHits.slice(0, 24).map(({ keyword, event }) => <article className="list-card" key={`${keyword}-${event.id}`}><div className="list-head"><strong>{keyword}</strong><span>{event.contact ?? 'Unknown contact'}</span></div><p>{compact(event.text)}</p><span className="mono">[{event.id}] {formatDate(event.timestamp)}</span></article>)}{keywordHits.length === 0 ? <p className="empty-state">No custom keyword hits matched the current workspace.</p> : null}</div></article>
        <article className="panel"><SectionHeader eyebrow="Patterns and entities" title="Recurring names, handles, links, emails, phones, and locations" /><div className="stack-list">{workspace.entities.slice(0, 14).map((entity) => <article className="list-card" key={entity.id}><div className="list-head"><strong>{entity.value}</strong><span>{entity.type}</span></div><p>{entity.count} mention(s) across {entity.uploads.length} upload(s).</p></article>)}</div></article>
      </section>

      <section className="dashboard-grid">
        <article className="panel"><SectionHeader eyebrow="Activity windows" title="Timeline and time patterns" /><div className="timeline-chart">{workspace.timeline.slice(-18).map((bucket) => <div className="timeline-bar" key={bucket.key}><div className="timeline-fill" style={{ height: `${Math.max(10, (bucket.count / Math.max(...workspace.timeline.map((item) => item.count), 1)) * 100)}%` }} /><strong>{bucket.count}</strong><span>{bucket.label}</span></div>)}</div></article>
        <article className="panel"><SectionHeader eyebrow="Signals" title="Deterministic findings" /><div className="stack-list">{workspace.signals.map((signal) => <article className="signal-card" key={signal.id}><div className="list-head"><strong>{signal.title}</strong><span className={`contact-label label-${signal.severity === 'high' ? 'female' : signal.severity === 'medium' ? 'unknown' : 'male'}`}>{signal.severity}</span></div><p>{signal.summary}</p><span>{signal.explanation}</span></article>)}</div></article>
      </section>

      <section className="dashboard-grid">
        <article className="panel"><SectionHeader eyebrow="AI findings" title="Grounded model output" subtitle="The AI path chunks long chat history and then synthesizes a final answer against the deterministic context." />{aiResult ? <article className="ai-result"><div className="list-head"><strong>{aiResult.provider} / {aiResult.model}</strong><span>{formatDate(aiResult.createdAt)}</span></div><p className="ai-question">{aiResult.question}</p><pre>{aiResult.answer}</pre></article> : <p className="empty-state">No AI analysis has been run yet.</p>}</article>
        <article className="panel"><SectionHeader eyebrow="Evidence viewer" title="Traceable source snippets" /><div className="stack-list">{workspace.evidenceSnippets.slice(0, 14).map((snippet) => <article className="evidence-card" key={snippet.eventId}><div className="list-head"><strong>{snippet.label}</strong><span>{formatDate(snippet.timestamp)}</span></div><p>{snippet.excerpt}</p><span className="mono">[{snippet.eventId}] {snippet.sourceFile}</span></article>)}</div></article>
      </section>
    </main>
  )
}
