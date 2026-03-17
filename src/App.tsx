import {
  startTransition,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
} from 'react'
import './App.css'
import type { AIProvider, AIResult, AISettings, EvidenceSnippet } from './types'
import { runAIReview } from './lib/ai'
import {
  downloadContactsCsv,
  downloadEventsJson,
  downloadKeywordHitsCsv,
  downloadWorkspaceReport,
} from './lib/exporters'
import { buildWorkspace } from './lib/insights'
import { parseSnapchatZip } from './lib/snapchatParser'
import { sampleUpload } from './sampleData'

const ACCESS_KEY = 'export-viewer-pro-access-code'
const NOTES_KEY = 'export-viewer-pro-private-notes'
const AI_SETTINGS_KEY = 'export-viewer-pro-ai-settings'

const DEFAULT_MODELS: Record<AIProvider, string> = {
  gemini: 'gemini-2.5-flash',
  openai: 'gpt-4.1-mini',
}

function formatDate(value: string | null) {
  if (!value) {
    return 'Unknown'
  }

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString()
}

function formatNumber(value: number) {
  return new Intl.NumberFormat().format(value)
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B'
  }

  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`
}

function scoreLabel(score: number) {
  if (score >= 80) {
    return 'High review priority'
  }
  if (score >= 55) {
    return 'Moderate review priority'
  }
  return 'Baseline review priority'
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

function EvidenceList(props: { snippets: EvidenceSnippet[] }) {
  if (props.snippets.length === 0) {
    return <p className="empty-state">No evidence snippets are available for this section yet.</p>
  }

  return (
    <div className="evidence-list">
      {props.snippets.map((snippet) => (
        <article className="evidence-card" key={snippet.eventId}>
          <div className="evidence-meta">
            <strong>{snippet.label}</strong>
            <span>{formatDate(snippet.timestamp)}</span>
          </div>
          <p>{snippet.excerpt}</p>
          <span className="mono">
            [{snippet.eventId}] {snippet.sourceFile}
          </span>
        </article>
      ))}
    </div>
  )
}

function App() {
  const [uploads, setUploads] = useState([sampleUpload])
  const [status, setStatus] = useState(
    'Demo upload loaded. Add one or more export zips to build a real workspace.',
  )
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [filter, setFilter] = useState('')
  const [notes, setNotes] = useState('')
  const [savedAccessCode, setSavedAccessCode] = useState('')
  const [accessInput, setAccessInput] = useState('')
  const [isUnlocked, setIsUnlocked] = useState(false)
  const [aiSettings, setAiSettings] = useState<AISettings>({
    provider: 'gemini',
    apiKey: '',
    model: DEFAULT_MODELS.gemini,
  })
  const [aiQuestion, setAiQuestion] = useState(
    'Summarize the strongest factual communication patterns and cite evidence IDs.',
  )
  const [aiResult, setAiResult] = useState<AIResult | null>(null)
  const [aiError, setAiError] = useState<string | null>(null)
  const [isAiLoading, setIsAiLoading] = useState(false)

  useEffect(() => {
    const storedCode = window.localStorage.getItem(ACCESS_KEY) ?? ''
    const storedNotes = window.localStorage.getItem(NOTES_KEY) ?? ''
    const storedSettings = window.sessionStorage.getItem(AI_SETTINGS_KEY)

    setSavedAccessCode(storedCode)
    setIsUnlocked(!storedCode)
    setNotes(storedNotes)

    if (storedSettings) {
      try {
        const parsed = JSON.parse(storedSettings) as AISettings
        setAiSettings(parsed)
      } catch {
        window.sessionStorage.removeItem(AI_SETTINGS_KEY)
      }
    }
  }, [])

  useEffect(() => {
    window.localStorage.setItem(NOTES_KEY, notes)
  }, [notes])

  useEffect(() => {
    window.sessionStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(aiSettings))
  }, [aiSettings])

  const deferredFilter = useDeferredValue(filter)
  const workspace = useMemo(() => buildWorkspace(uploads), [uploads])
  const normalizedFilter = deferredFilter.trim().toLowerCase()

  const filteredEvents = useMemo(
    () =>
      (!normalizedFilter
        ? workspace.events
        : workspace.events.filter((event) =>
            [
              event.contact,
              event.text,
              event.detail,
              event.locationName,
              event.region,
              event.device,
            ]
              .filter(Boolean)
              .join(' ')
              .toLowerCase()
              .includes(normalizedFilter),
          )
      )
        .slice(-12)
        .reverse(),
    [normalizedFilter, workspace.events],
  )

  const filteredContacts = useMemo(
    () =>
      workspace.contacts
        .filter((contact) =>
          normalizedFilter ? contact.name.toLowerCase().includes(normalizedFilter) : true,
        )
        .slice(0, 8),
    [normalizedFilter, workspace.contacts],
  )

  const filteredEntities = useMemo(
    () =>
      workspace.entities
        .filter((entity) =>
          normalizedFilter ? entity.value.toLowerCase().includes(normalizedFilter) : true,
        )
        .slice(0, 12),
    [normalizedFilter, workspace.entities],
  )

  const filteredEvidence = useMemo(
    () =>
      workspace.evidenceSnippets.filter((snippet) =>
        normalizedFilter
          ? `${snippet.label} ${snippet.excerpt} ${snippet.sourceFile}`
              .toLowerCase()
              .includes(normalizedFilter)
          : true,
      ),
    [normalizedFilter, workspace.evidenceSnippets],
  )

  const reviewScore = Math.min(
    100,
    Math.round(
      workspace.signals.slice(0, 5).reduce((sum, signal) => sum + signal.score, 0) /
        Math.max(1, Math.min(5, workspace.signals.length)) +
        workspace.keywordHits.length * 1.5,
    ),
  )
  const maxTimeline = Math.max(...workspace.timeline.map((bucket) => bucket.count), 1)
  const maxHour = Math.max(...workspace.hourBuckets.map((bucket) => bucket.count), 1)
  const maxHeat = Math.max(...workspace.heatmap.map((cell) => cell.count), 1)

  async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const selected = [...(event.target.files ?? [])]
    if (selected.length === 0) {
      return
    }

    setIsLoading(true)
    setError(null)
    setStatus(`Parsing ${selected.length} upload${selected.length === 1 ? '' : 's'} locally...`)

    try {
      const parsedUploads = await Promise.all(selected.map((file) => parseSnapchatZip(file)))
      startTransition(() => {
        setUploads((current) => {
          const realCurrent = current[0]?.upload.id === sampleUpload.upload.id ? [] : current
          return [...realCurrent, ...parsedUploads]
        })
      })
      setStatus(
        `Loaded ${parsedUploads.length} new upload${parsedUploads.length === 1 ? '' : 's'} with ${parsedUploads.reduce((sum, upload) => sum + upload.events.length, 0)} normalized events.`,
      )
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Upload parsing failed.')
      setStatus('Upload failed. Existing workspace remains loaded.')
    } finally {
      setIsLoading(false)
      event.target.value = ''
    }
  }

  async function handleAiRun() {
    setIsAiLoading(true)
    setAiError(null)

    try {
      const result = await runAIReview(aiSettings, workspace, aiQuestion)
      setAiResult(result)
    } catch (caught) {
      setAiError(caught instanceof Error ? caught.message : 'AI analysis failed.')
    } finally {
      setIsAiLoading(false)
    }
  }

  function createOrUnlockAccess() {
    if (!savedAccessCode) {
      if (!accessInput.trim()) {
        setError('Enter a local access code first.')
        return
      }

      window.localStorage.setItem(ACCESS_KEY, accessInput)
      setSavedAccessCode(accessInput)
      setIsUnlocked(true)
      setAccessInput('')
      setError(null)
      return
    }

    if (accessInput === savedAccessCode) {
      setIsUnlocked(true)
      setAccessInput('')
      setError(null)
      return
    }

    setError('Access code did not match this browser.')
  }

  function removeAccessCode() {
    window.localStorage.removeItem(ACCESS_KEY)
    setSavedAccessCode('')
    setIsUnlocked(true)
    setStatus('Removed the local browser access code.')
  }

  function clearWorkspace() {
    setUploads([sampleUpload])
    setStatus('Reverted to demo data.')
    setError(null)
    setAiResult(null)
  }

  if (!isUnlocked) {
    return (
      <main className="lock-screen">
        <section className="lock-card">
          <SectionHeader
            eyebrow="Private access"
            title="Unlock your local dashboard"
            subtitle="This gate only protects the browser session on this device. It is not server-side authentication."
          />
          <input
            className="lock-input"
            onChange={(event) => setAccessInput(event.target.value)}
            placeholder={savedAccessCode ? 'Enter access code' : 'Create access code'}
            type="password"
            value={accessInput}
          />
          <div className="hero-actions">
            <button className="primary-button" onClick={createOrUnlockAccess} type="button">
              {savedAccessCode ? 'Unlock' : 'Create code'}
            </button>
          </div>
          {error ? <p className="error-line dark-error">{error}</p> : null}
        </section>
      </main>
    )
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Communication intelligence workspace</p>
          <h1>Advanced review dashboard</h1>
        </div>
        <nav className="topnav" aria-label="Dashboard sections">
          <a href="#overview">Overview</a>
          <a href="#uploads">Uploads</a>
          <a href="#patterns">Patterns</a>
          <a href="#entities">Entities</a>
          <a href="#ai">AI</a>
          <a href="#evidence">Evidence</a>
        </nav>
      </header>

      <section className="hero-panel" id="overview">
        <div className="hero-copy">
          <SectionHeader
            eyebrow="Executive overview"
            title="One workspace for uploads, deterministic analytics, and optional AI review"
            subtitle="The platform stays neutral and evidence-driven. Upload parsing and deterministic metrics work without any AI setup."
          />

          <div className="hero-actions">
            <label className="primary-button file-picker">
              <input accept=".zip" multiple onChange={handleUpload} type="file" />
              {isLoading ? 'Parsing uploads...' : 'Add export zip'}
            </label>
            <button className="secondary-button" onClick={clearWorkspace} type="button">
              Load demo data
            </button>
            <button className="ghost-button" onClick={removeAccessCode} type="button">
              Remove local code
            </button>
          </div>

          <div className="export-row">
            <button className="chip-button" onClick={() => downloadEventsJson(workspace.events)} type="button">
              Export events JSON
            </button>
            <button className="chip-button" onClick={() => downloadContactsCsv(workspace.contacts)} type="button">
              Export contacts CSV
            </button>
            <button className="chip-button" onClick={() => downloadKeywordHitsCsv(workspace.keywordHits)} type="button">
              Export keyword CSV
            </button>
            <button className="chip-button" onClick={() => downloadWorkspaceReport(workspace)} type="button">
              Export report JSON
            </button>
          </div>

          <p className="status-line">{status}</p>
          {error ? <p className="error-line">{error}</p> : null}
          {workspace.warnings.length > 0 ? (
            <div className="warning-box">
              {workspace.warnings.slice(0, 3).map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
            </div>
          ) : null}
        </div>

        <aside className="score-panel">
          <div className="score-ring">
            <strong>{reviewScore}</strong>
            <span>{scoreLabel(reviewScore)}</span>
          </div>

          <div className="metric-grid">
            <article className="metric-card">
              <span>Uploads</span>
              <strong>{workspace.stats.uploads}</strong>
            </article>
            <article className="metric-card">
              <span>Contacts</span>
              <strong>{workspace.stats.uniqueContacts}</strong>
            </article>
            <article className="metric-card">
              <span>Entities</span>
              <strong>{workspace.stats.uniqueEntities}</strong>
            </article>
            <article className="metric-card">
              <span>Signals</span>
              <strong>{workspace.signals.length}</strong>
            </article>
          </div>
        </aside>
      </section>

      <section className="stats-grid">
        <article className="stat-card">
          <span>Total normalized events</span>
          <strong>{formatNumber(workspace.stats.totalEvents)}</strong>
          <p>Includes chat, search, location, login, and memory rows retained after parsing.</p>
        </article>
        <article className="stat-card">
          <span>Observed date range</span>
          <strong>
            {workspace.stats.dateRange.start
              ? formatDate(workspace.stats.dateRange.start).split(',')[0]
              : 'Unknown'}
          </strong>
          <p>
            Through{' '}
            {workspace.stats.dateRange.end
              ? formatDate(workspace.stats.dateRange.end).split(',')[0]
              : 'Unknown'}
          </p>
        </article>
        <article className="stat-card">
          <span>Top contact</span>
          <strong>{workspace.contacts[0]?.name ?? 'None'}</strong>
          <p>{workspace.contacts[0]?.interactions ?? 0} linked events</p>
        </article>
        <article className="stat-card">
          <span>Strongest signal</span>
          <strong>{workspace.signals[0]?.title ?? 'None'}</strong>
          <p>{workspace.signals[0]?.summary ?? 'No deterministic flags above threshold.'}</p>
        </article>
      </section>

      <section className="dashboard-grid" id="uploads">
        <article className="panel panel-span-two">
          <SectionHeader
            eyebrow="Upload/account overview"
            title="Each upload keeps its own provenance and account summary"
          />
          <div className="upload-grid">
            {workspace.uploads.map((upload) => (
              <article className="upload-card" key={upload.id}>
                <div className="upload-head">
                  <div>
                    <strong>{upload.fileName}</strong>
                    <span>{formatBytes(upload.sizeBytes)}</span>
                  </div>
                  <span className="pill neutral">{upload.supportedFiles} supported files</span>
                </div>
                <div className="upload-meta">
                  <span>Processed {formatDate(upload.processedAt)}</span>
                  <span>
                    Account {upload.account.displayName ?? upload.account.username ?? 'Unknown'}
                  </span>
                  <span>{upload.account.email ?? 'No email recovered'}</span>
                  <span>{upload.account.phone ?? 'No phone recovered'}</span>
                </div>
                <div className="category-strip">
                  {Object.entries(upload.categoryCounts).map(([key, value]) => (
                    <span className="category-chip" key={key}>
                      {key}: {value}
                    </span>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </article>

        <article className="panel">
          <SectionHeader
            eyebrow="Facts-only summary"
            title="Current workspace summary"
          />
          <ul className="fact-list">
            {workspace.factsSummary.map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
          </ul>
        </article>

        <article className="panel">
          <SectionHeader
            eyebrow="Private notes"
            title="Local notes for this browser"
            subtitle="Stored in local storage on this device."
          />
          <textarea
            className="notes-field"
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Capture working hypotheses, follow-up items, or export notes."
            value={notes}
          />
        </article>
      </section>

      <section className="dashboard-grid" id="patterns">
        <article className="panel panel-span-two">
          <SectionHeader
            eyebrow="Timeline explorer"
            title="Daily activity reconstruction"
            subtitle="The timeline is derived from normalized event timestamps, not display-only widget state."
          />
          <div className="timeline-chart">
            {workspace.timeline.slice(-18).map((bucket) => (
              <div className="timeline-bar" key={bucket.key}>
                <div
                  className="timeline-fill"
                  style={{ height: `${Math.max(10, (bucket.count / maxTimeline) * 100)}%` }}
                />
                <strong>{bucket.count}</strong>
                <span>{bucket.label}</span>
              </div>
            ))}
          </div>
        </article>

        <article className="panel">
          <SectionHeader eyebrow="Activity by hour" title="Hour distribution" />
          <div className="hour-grid">
            {workspace.hourBuckets.map((bucket) => (
              <div className="hour-cell" key={bucket.hour}>
                <div
                  className="hour-fill"
                  style={{ height: `${Math.max(8, (bucket.count / maxHour) * 100)}%` }}
                />
                <span>{bucket.hour}</span>
              </div>
            ))}
          </div>
        </article>

        <article className="panel">
          <SectionHeader eyebrow="Conversation heatmap" title="Weekday x hour activity" />
          <div className="heatmap">
            {workspace.heatmap.map((cell) => (
              <div
                className="heatmap-cell"
                key={`${cell.day}-${cell.hour}`}
                style={{
                  opacity: cell.count === 0 ? 0.1 : Math.max(0.2, cell.count / maxHeat),
                }}
                title={`${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][cell.day]} ${cell.hour}:00 — ${cell.count}`}
              />
            ))}
          </div>
          <div className="heatmap-axis">
            <span>Sun</span>
            <span>Wed</span>
            <span>Sat</span>
          </div>
        </article>
      </section>

      <section className="dashboard-grid" id="entities">
        <article className="panel">
          <SectionHeader
            eyebrow="Communication patterns"
            title="Top contacts and intensity shifts"
          />
          <label className="search-field">
            <span>Filter contacts, evidence, and entities</span>
            <input
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Search names, phrases, handles, places, files..."
              type="search"
              value={filter}
            />
          </label>
          <div className="stack-list">
            {filteredContacts.map((contact) => (
              <article className="list-card" key={contact.name}>
                <div className="list-head">
                  <strong>{contact.name}</strong>
                  <span>{contact.interactions} events</span>
                </div>
                <div className="list-meta">
                  <span>{contact.messageCount} chats</span>
                  <span>{contact.searchCount} searches</span>
                  <span>{contact.lateNightInteractions} overnight</span>
                  <span>{contact.keywordHits} tone matches</span>
                </div>
                <p>
                  First seen {formatDate(contact.firstSeen)}. Last seen {formatDate(contact.lastSeen)}.
                </p>
              </article>
            ))}
            {filteredContacts.length === 0 ? (
              <p className="empty-state">No contacts matched the current filter.</p>
            ) : null}
          </div>
        </article>

        <article className="panel">
          <SectionHeader eyebrow="Entities" title="Names, handles, emails, links, and locations" />
          <div className="entity-grid">
            {filteredEntities.map((entity) => (
              <article className="entity-card" key={entity.id}>
                <span className="pill neutral">{entity.type}</span>
                <strong>{entity.value}</strong>
                <p>{entity.count} mentions</p>
              </article>
            ))}
            {filteredEntities.length === 0 ? (
              <p className="empty-state">No entities matched the current filter.</p>
            ) : null}
          </div>
        </article>

        <article className="panel">
          <SectionHeader eyebrow="Repeated language" title="Recurring phrase patterns" />
          <div className="stack-list">
            {workspace.repeatedPhrases.slice(0, 10).map((pattern) => (
              <article className="list-card" key={pattern.phrase}>
                <div className="list-head">
                  <strong>{pattern.phrase}</strong>
                  <span>{pattern.count} repeats</span>
                </div>
                <p>{pattern.contacts.join(', ') || 'No contact label attached'}</p>
              </article>
            ))}
          </div>
        </article>

        <article className="panel">
          <SectionHeader eyebrow="Tone categories" title="Deterministic language classification" />
          <div className="stack-list">
            {workspace.toneSummaries.map((tone) => (
              <article className="list-card" key={tone.category}>
                <div className="list-head">
                  <strong>{tone.label}</strong>
                  <span>{tone.count} matches</span>
                </div>
                <p>{tone.contacts.join(', ') || 'No contact label attached'}</p>
              </article>
            ))}
            {workspace.toneSummaries.length === 0 ? (
              <p className="empty-state">No deterministic tone rules matched the current data.</p>
            ) : null}
          </div>
        </article>
      </section>

      <section className="dashboard-grid">
        <article className="panel">
          <SectionHeader
            eyebrow="Anomalies and notable changes"
            title="Deterministic findings"
          />
          <div className="stack-list">
            {workspace.signals.map((signal) => (
              <article className="signal-card" key={signal.id}>
                <div className="list-head">
                  <strong>{signal.title}</strong>
                  <span className={`pill severity-${signal.severity}`}>{signal.severity}</span>
                </div>
                <p>{signal.summary}</p>
                <span>{signal.explanation}</span>
              </article>
            ))}
          </div>
        </article>

        <article className="panel">
          <SectionHeader eyebrow="Notable periods" title="Periods that stand out" />
          <div className="stack-list">
            {workspace.notablePeriods.map((period) => (
              <article className="list-card" key={period.id}>
                <div className="list-head">
                  <strong>{period.label}</strong>
                  <span>
                    {period.start === period.end ? period.start : `${period.start} to ${period.end}`}
                  </span>
                </div>
                <p>{period.summary}</p>
              </article>
            ))}
          </div>
        </article>
      </section>

      <section className="dashboard-grid" id="ai">
        <article className="panel">
          <SectionHeader
            eyebrow="AI settings"
            title="Optional Gemini or OpenAI review"
            subtitle="Keys are kept in session storage only. Browser-side requests expose the key to this session, so use scoped keys."
          />
          <div className="settings-grid">
            <label>
              <span>Provider</span>
              <select
                value={aiSettings.provider}
                onChange={(event) => {
                  const provider = event.target.value as AIProvider
                  setAiSettings((current) => ({
                    ...current,
                    provider,
                    model:
                      current.provider === provider ? current.model : DEFAULT_MODELS[provider],
                  }))
                }}
              >
                <option value="gemini">Gemini</option>
                <option value="openai">OpenAI</option>
              </select>
            </label>
            <label>
              <span>Model</span>
              <input
                type="text"
                value={aiSettings.model}
                onChange={(event) =>
                  setAiSettings((current) => ({ ...current, model: event.target.value }))
                }
              />
            </label>
            <label className="settings-span-two">
              <span>API key</span>
              <input
                type="password"
                value={aiSettings.apiKey}
                onChange={(event) =>
                  setAiSettings((current) => ({ ...current, apiKey: event.target.value }))
                }
                placeholder="Paste a provider API key"
              />
            </label>
            <label className="settings-span-two">
              <span>Question</span>
              <textarea
                className="ai-prompt"
                value={aiQuestion}
                onChange={(event) => setAiQuestion(event.target.value)}
              />
            </label>
          </div>
          <div className="hero-actions">
            <button className="primary-button" onClick={handleAiRun} type="button">
              {isAiLoading ? 'Running AI review...' : 'Run grounded AI review'}
            </button>
          </div>
          {aiError ? <p className="error-line dark-error">{aiError}</p> : null}
        </article>

        <article className="panel">
          <SectionHeader
            eyebrow="AI findings"
            title="Provider output"
            subtitle="AI is given deterministic metrics plus evidence snippets and asked to stay grounded."
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
            <p className="empty-state">
              No AI review yet. Deterministic analytics remain fully usable without provider setup.
            </p>
          )}
        </article>
      </section>

      <section className="dashboard-grid" id="evidence">
        <article className="panel">
          <SectionHeader eyebrow="Evidence / source snippets" title="Traceable excerpts" />
          <EvidenceList snippets={filteredEvidence.slice(0, 12)} />
        </article>

        <article className="panel">
          <SectionHeader eyebrow="Recent normalized rows" title="Latest retained events" />
          <div className="stack-list">
            {filteredEvents.map((event) => (
              <article className="list-card" key={event.id}>
                <div className="list-head">
                  <strong>{event.contact ?? event.category}</strong>
                  <span>{formatDate(event.timestamp)}</span>
                </div>
                <p>{event.text ?? event.detail ?? event.locationName ?? 'No text detail'}</p>
                <span className="mono">
                  [{event.id}] {event.sourceFile}
                </span>
              </article>
            ))}
          </div>
        </article>
      </section>
    </main>
  )
}

export default App
