import { startTransition, useDeferredValue, useState } from 'react'
import './App.css'
import {
  downloadContactsCsv,
  downloadEventsJson,
  downloadKeywordHitsCsv,
} from './lib/exporters'
import { parseSnapchatZip } from './lib/snapchatParser'
import { sampleDataset } from './sampleData'
import type { ParsedDataset } from './types'

const statLabels = [
  ['totalEvents', 'Events kept'],
  ['chatEvents', 'Chat rows'],
  ['locationEvents', 'Location rows'],
  ['uniqueContacts', 'Unique contacts'],
] as const

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

function App() {
  const [dataset, setDataset] = useState<ParsedDataset>(sampleDataset)
  const [status, setStatus] = useState('Showing sample data until you upload a Snapchat export zip.')
  const [isLoading, setIsLoading] = useState(false)
  const [contactFilter, setContactFilter] = useState('')
  const [error, setError] = useState<string | null>(null)

  const deferredFilter = useDeferredValue(contactFilter)

  const normalizedFilter = deferredFilter.trim().toLowerCase()
  const filteredEvents = !normalizedFilter
    ? dataset.events.slice(-8).reverse()
    : dataset.events
        .filter((event) => {
          const haystack = [event.contact, event.text, event.detail, event.locationName]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()

          return haystack.includes(normalizedFilter)
        })
        .slice(-8)
        .reverse()

  const topContacts = dataset.contacts
    .filter((contact) =>
      normalizedFilter ? contact.name.toLowerCase().includes(normalizedFilter) : true,
    )
    .slice(0, 6)

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

  return (
    <main className="app-shell">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Consent-based Snapchat export analyzer</p>
          <h1>Upload a Snapchat export zip and review unusual patterns locally.</h1>
          <p className="hero-text">
            This dashboard is built for consent-based review of a Snapchat export that the
            account owner has chosen to analyze. It highlights contact spikes, late-night
            activity, search patterns, location overlap, device changes, and sensitive
            saved-chat phrases without sending uploads to a server.
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
              Use sample data
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

        <aside className="hero-panel">
          <p className="panel-label">Useful signals</p>
          <ul className="stack-list compact">
            <li>
              <span>Contact growth</span>
              <strong>frequency spikes</strong>
            </li>
            <li>
              <span>Saved chat review</span>
              <strong>phrase matches</strong>
            </li>
            <li>
              <span>Context signals</span>
              <strong>locations + searches</strong>
            </li>
            <li>
              <span>Audit trail</span>
              <strong>logins + devices</strong>
            </li>
          </ul>
          <p className="panel-note">
            Heuristics are clues, not proof. The dashboard should support careful review,
            not jump to conclusions.
          </p>
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
              <article className="table-row" key={contact.name}>
                <strong>{contact.name}</strong>
                <span>{contact.interactions} interactions</span>
                <span>{contact.lateNightInteractions} late-night</span>
                <span>{contact.keywordHits} phrase hits</span>
                <span>Last seen {formatDate(contact.lastSeen)}</span>
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
                <span>{event.contact ?? event.locationName ?? 'Unknown source'}</span>
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

        <article className="dashboard-card">
          <div className="section-heading">
            <p className="eyebrow">MVP roadmap</p>
            <h3>Useful features to add next</h3>
          </div>

          <ol className="roadmap-list">
            <li>Export a PDF review packet and CSV evidence tables from the current filters.</li>
            <li>Let the user edit the phrase watchlist and define their own boundaries.</li>
            <li>Add a visual day-by-day timeline with location and communication overlap.</li>
            <li>Score new or suddenly frequent contacts with a transparent explanation panel.</li>
          </ol>

          <div className="callout">
            <p className="callout-title">Cheap hosting path</p>
            <p>
              Keep this as a static app on Firebase Hosting first. Only add Cloud Run if we
              need secure user accounts or server-generated exports.
            </p>
          </div>
        </article>
      </section>
    </main>
  )
}

export default App
