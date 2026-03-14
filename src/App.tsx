import { startTransition, useDeferredValue, useEffect, useState } from 'react'
import './App.css'
import {
  downloadContactsCsv,
  downloadEventsJson,
  downloadKeywordHitsCsv,
} from './lib/exporters'
import { parseSnapchatZip } from './lib/snapchatParser'
import { sampleDataset } from './sampleData'
import type { NormalizedEvent, ParsedDataset } from './types'

const statLabels = [
  ['totalEvents', 'Events kept'],
  ['chatEvents', 'Chat rows'],
  ['locationEvents', 'Location rows'],
  ['uniqueContacts', 'Unique contacts'],
] as const

const ACCESS_KEY = 'export-viewer-pro-access-code'
const NOTES_KEY = 'export-viewer-pro-private-notes'

function formatDate(value: string | null) {
  if (!value) {
    return 'Unknown'
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return 'Unknown'
  }

  return date.toLocaleString()
}

function formatDay(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  })
}

function eventLabel(event: NormalizedEvent) {
  return event.contact ?? event.locationName ?? event.device ?? 'Unknown source'
}

function App() {
  const [dataset, setDataset] = useState<ParsedDataset>(sampleDataset)
  const [status, setStatus] = useState('Showing sample data until you upload a Snapchat export zip.')
  const [isLoading, setIsLoading] = useState(false)
  const [contactFilter, setContactFilter] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [savedAccessCode, setSavedAccessCode] = useState('')
  const [accessInput, setAccessInput] = useState('')
  const [isUnlocked, setIsUnlocked] = useState(false)
  const [notes, setNotes] = useState('')

  useEffect(() => {
    const storedCode = window.localStorage.getItem(ACCESS_KEY) ?? ''
    const storedNotes = window.localStorage.getItem(NOTES_KEY) ?? ''
    setSavedAccessCode(storedCode)
    setIsUnlocked(!storedCode)
    setNotes(storedNotes)
  }, [])

  useEffect(() => {
    window.localStorage.setItem(NOTES_KEY, notes)
  }, [notes])

  const deferredFilter = useDeferredValue(contactFilter)
  const normalizedFilter = deferredFilter.trim().toLowerCase()

  const filteredEvents = !normalizedFilter
    ? dataset.events.slice(-10).reverse()
    : dataset.events
        .filter((event) => {
          const haystack = [
            event.contact,
            event.text,
            event.detail,
            event.locationName,
            event.device,
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()

          return haystack.includes(normalizedFilter)
        })
        .slice(-10)
        .reverse()

  const topContacts = dataset.contacts
    .filter((contact) =>
      normalizedFilter ? contact.name.toLowerCase().includes(normalizedFilter) : true,
    )
    .slice(0, 6)

  const riskScore = Math.min(
    100,
    dataset.signals.length * 12 +
      dataset.keywordHits.length * 9 +
      topContacts.reduce((sum, contact) => sum + contact.lateNightInteractions, 0) * 2,
  )

  const categoryCards = [
    { label: 'Chats', value: dataset.stats.chatEvents, tone: 'sun' },
    { label: 'Locations', value: dataset.stats.locationEvents, tone: 'sea' },
    { label: 'Logins', value: dataset.stats.loginEvents, tone: 'ink' },
    { label: 'Searches', value: dataset.stats.searchEvents, tone: 'rose' },
  ]

  const hourlyActivity = Array.from({ length: 24 }, (_, hour) => {
    const count = dataset.events.filter((event) => {
      if (!event.timestamp) {
        return false
      }

      return new Date(event.timestamp).getHours() === hour
    }).length

    return { hour, count }
  })
  const maxHourCount = Math.max(...hourlyActivity.map((bucket) => bucket.count), 1)

  const dailyActivityMap = new Map<string, number>()
  dataset.events.forEach((event) => {
    if (!event.timestamp) {
      return
    }

    const day = event.timestamp.slice(0, 10)
    dailyActivityMap.set(day, (dailyActivityMap.get(day) ?? 0) + 1)
  })
  const dailyActivity = [...dailyActivityMap.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(-8)
    .map(([day, count]) => ({ day, count }))
  const maxDayCount = Math.max(...dailyActivity.map((entry) => entry.count), 1)

  async function handleUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]

    if (!file) {
      return
    }

    setIsLoading(true)
    setError(null)
    setStatus(`Parsing ${file.name} locally in your browser...`)

    try {
      const parsed = await parseSnapchatZip(file)

      startTransition(() => {
        setDataset(parsed)
      })

      setStatus(
        `Parsed ${parsed.fileSummaries.length} supported files from ${file.name}. Data stayed in the browser.`,
      )
    } catch (caught) {
      const message =
        caught instanceof Error
          ? caught.message
          : 'The zip could not be parsed. Try a different export file.'
      setError(message)
      setStatus('The last upload failed, so the sample dataset is still loaded.')
    } finally {
      setIsLoading(false)
      event.target.value = ''
    }
  }

  function saveAccessCode() {
    if (!accessInput.trim()) {
      setError('Enter a private code first.')
      return
    }

    window.localStorage.setItem(ACCESS_KEY, accessInput)
    setSavedAccessCode(accessInput)
    setIsUnlocked(true)
    setError(null)
    setStatus('Private code saved on this device. It is only a local privacy gate, not server auth.')
    setAccessInput('')
  }

  function unlockWithCode() {
    if (!savedAccessCode) {
      setIsUnlocked(true)
      return
    }

    if (accessInput === savedAccessCode) {
      setIsUnlocked(true)
      setError(null)
      setAccessInput('')
      return
    }

    setError('That private code does not match this browser.')
  }

  function clearPrivacyGate() {
    window.localStorage.removeItem(ACCESS_KEY)
    setSavedAccessCode('')
    setIsUnlocked(true)
    setAccessInput('')
    setStatus('Removed the local privacy gate from this browser.')
  }

  if (!isUnlocked) {
    return (
      <main className="lock-screen">
        <section className="lock-card">
          <p className="eyebrow">Personal mode</p>
          <h1>Unlock your private dashboard.</h1>
          <p className="hero-text">
            This gate is stored only in this browser to keep casual visitors out. It is not
            a secure server-side login.
          </p>
          <input
            className="lock-input"
            onChange={(event) => setAccessInput(event.target.value)}
            placeholder={savedAccessCode ? 'Enter your access code' : 'Create an access code'}
            type="password"
            value={accessInput}
          />
          <div className="hero-actions">
            <button
              className="primary-link button-reset"
              onClick={savedAccessCode ? unlockWithCode : saveAccessCode}
              type="button"
            >
              {savedAccessCode ? 'Unlock dashboard' : 'Create access code'}
            </button>
          </div>
          {error ? <p className="lock-error">{error}</p> : null}
        </section>
      </main>
    )
  }

  return (
    <main className="app-shell">
      <section className="hero hero-advanced">
        <div className="hero-copy">
          <p className="eyebrow">Private export dashboard</p>
          <h1>One personal workspace for uploads, signal review, and private notes.</h1>
          <p className="hero-text">
            Your dashboard runs browser-side, keeps exports local, and layers in a richer
            command center: activity maps, contact scoring, session notes, and one-click
            exports for whatever you decide to keep.
          </p>

          <div className="hero-actions">
            <label className="primary-link file-picker">
              <input accept=".zip" onChange={handleUpload} type="file" />
              {isLoading ? 'Parsing zip...' : 'Upload Snapchat zip'}
            </label>
            <button
              className="secondary-link button-reset"
              onClick={() => {
                setDataset(sampleDataset)
                setStatus('Reverted to the built-in sample dataset.')
                setError(null)
              }}
              type="button"
            >
              Load demo data
            </button>
            <button className="ghost-link" onClick={clearPrivacyGate} type="button">
              Remove local code
            </button>
          </div>

          <p className="status-line">{status}</p>
          {error ? <p className="error-line">{error}</p> : null}

          <div className="export-actions">
            <button
              className="export-button"
              onClick={() => downloadEventsJson(dataset.events)}
              type="button"
            >
              Export events JSON
            </button>
            <button
              className="export-button"
              onClick={() => downloadContactsCsv(dataset.contacts)}
              type="button"
            >
              Export contacts CSV
            </button>
            <button
              className="export-button"
              onClick={() => downloadKeywordHitsCsv(dataset.keywordHits)}
              type="button"
            >
              Export keyword hits CSV
            </button>
          </div>
        </div>

        <aside className="hero-panel hero-score">
          <p className="panel-label">Session score</p>
          <div className="score-ring">
            <strong>{riskScore}</strong>
            <span>/100</span>
          </div>
          <p className="panel-note">
            This is a weighted heuristic based on detected signals, phrase matches, and
            repeated late-night contact activity. It is meant to prioritize review, not
            decide intent.
          </p>
          <div className="mini-stat-grid">
            {categoryCards.map((card) => (
              <article className={`mini-stat tone-${card.tone}`} key={card.label}>
                <span>{card.label}</span>
                <strong>{card.value}</strong>
              </article>
            ))}
          </div>
        </aside>
      </section>

      <section className="stats-grid" aria-label="Dataset stats">
        {statLabels.map(([key, label]) => (
          <article className="stat-card" key={key}>
            <p>{label}</p>
            <h2>{dataset.stats[key]}</h2>
            <span>Updated from the currently loaded export set.</span>
          </article>
        ))}
      </section>

      <section className="dashboard-grid">
        <article className="dashboard-card dashboard-span-two">
          <div className="section-heading">
            <p className="eyebrow">Activity map</p>
            <h3>When the account is busiest</h3>
          </div>

          <div className="viz-grid">
            <section className="viz-card">
              <h4>Hourly activity</h4>
              <div className="bar-chart">
                {hourlyActivity.map((bucket) => (
                  <div className="bar-slot" key={bucket.hour}>
                    <div
                      className="bar-fill"
                      style={{
                        height: `${Math.max(10, (bucket.count / maxHourCount) * 100)}%`,
                      }}
                    />
                    <span>{bucket.hour}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="viz-card">
              <h4>Recent daily volume</h4>
              <div className="day-chart">
                {dailyActivity.map((entry) => (
                  <div className="day-row" key={entry.day}>
                    <span>{formatDay(entry.day)}</span>
                    <div className="day-track">
                      <div
                        className="day-fill"
                        style={{ width: `${Math.max(8, (entry.count / maxDayCount) * 100)}%` }}
                      />
                    </div>
                    <strong>{entry.count}</strong>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </article>

        <article className="dashboard-card">
          <div className="section-heading">
            <p className="eyebrow">Detection</p>
            <h3>Signals worth reviewing</h3>
          </div>

          <div className="signal-list">
            {dataset.signals.map((signal) => (
              <article className="signal-card" key={signal.title}>
                <div>
                  <h4>{signal.title}</h4>
                  <p>{signal.summary}</p>
                </div>
                <span className={`confidence-tag severity-${signal.severity}`}>
                  {signal.severity}
                </span>
              </article>
            ))}
          </div>
        </article>

        <article className="dashboard-card">
          <div className="section-heading">
            <p className="eyebrow">Private notes</p>
            <h3>Session notes saved only in this browser</h3>
          </div>

          <textarea
            className="notes-field"
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Add what stands out, which contacts need follow-up, or what to export later..."
            value={notes}
          />
        </article>

        <article className="dashboard-card">
          <div className="section-heading">
            <p className="eyebrow">Contacts</p>
            <h3>Most active contacts and repeated patterns</h3>
          </div>

          <label className="search-field">
            <span>Filter contacts or events</span>
            <input
              onChange={(event) => setContactFilter(event.target.value)}
              placeholder="Search names, phrases, places..."
              type="search"
              value={contactFilter}
            />
          </label>

          <div className="table-list">
            {topContacts.map((contact) => (
              <article className="table-row contact-row" key={contact.name}>
                <div>
                  <strong>{contact.name}</strong>
                  <span>Last seen {formatDate(contact.lastSeen)}</span>
                </div>
                <div>
                  <span>{contact.interactions} interactions</span>
                  <span>{contact.lateNightInteractions} late-night</span>
                  <span>{contact.keywordHits} phrase hits</span>
                </div>
              </article>
            ))}
            {topContacts.length === 0 ? (
              <p className="empty-state">No contacts matched the current filter.</p>
            ) : null}
          </div>
        </article>

        <article className="dashboard-card">
          <div className="section-heading">
            <p className="eyebrow">Saved chat review</p>
            <h3>Messages with sensitive phrase matches</h3>
          </div>

          <div className="keyword-grid">
            {dataset.keywordHits.slice(0, 8).map((hit) => (
              <article className="keyword-card" key={`${hit.contact}-${hit.timestamp}-${hit.phrase}`}>
                <p className="keyword-phrase">{hit.phrase}</p>
                <strong>{hit.contact}</strong>
                <span>{formatDate(hit.timestamp)}</span>
                <p>{hit.excerpt}</p>
              </article>
            ))}
            {dataset.keywordHits.length === 0 ? (
              <p className="empty-state">
                No sensitive phrase matches were found in the loaded saved-chat text.
              </p>
            ) : null}
          </div>
        </article>

        <article className="dashboard-card">
          <div className="section-heading">
            <p className="eyebrow">Recent events</p>
            <h3>Latest normalized rows kept by the analyzer</h3>
          </div>

          <div className="table-list">
            {filteredEvents.map((event) => (
              <article className="table-row event-row" key={event.id}>
                <strong>{event.category}</strong>
                <span>{eventLabel(event)}</span>
                <span>{event.text ?? event.detail ?? 'No free text'}</span>
                <span>{formatDate(event.timestamp)}</span>
              </article>
            ))}
          </div>
        </article>

        <article className="dashboard-card">
          <div className="section-heading">
            <p className="eyebrow">Import coverage</p>
            <h3>Files the parser found useful</h3>
          </div>

          <div className="table-list">
            {dataset.fileSummaries.slice(0, 8).map((file) => (
              <article className="table-row" key={file.path}>
                <strong>{file.category}</strong>
                <span>{file.rows} normalized rows</span>
                <span className="mono">{file.path}</span>
              </article>
            ))}
            {dataset.fileSummaries.length === 0 ? (
              <p className="empty-state">
                Sample data is loaded, so no zip file inventory is shown yet.
              </p>
            ) : null}
          </div>
        </article>
      </section>
    </main>
  )
}

export default App
