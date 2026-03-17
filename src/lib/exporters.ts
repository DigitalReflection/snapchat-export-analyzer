import type {
  ContactSummary,
  KeywordHit,
  NormalizedEvent,
  WorkspaceDataset,
} from '../types'
import { buildWorkspaceReport } from './insights'

function toCsv(rows: Record<string, string | number | null>[]) {
  if (rows.length === 0) {
    return ''
  }

  const headers = Object.keys(rows[0])
  const escape = (value: string | number | null) => {
    const text = value === null ? '' : String(value)
    const escaped = text.replace(/"/g, '""')
    return /[",\n]/.test(escaped) ? `"${escaped}"` : escaped
  }

  return [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => escape(row[header])).join(',')),
  ].join('\n')
}

function download(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

export function downloadEventsJson(events: NormalizedEvent[]) {
  download(
    'communication-events.json',
    JSON.stringify(events, null, 2),
    'application/json;charset=utf-8',
  )
}

export function downloadKeywordHitsCsv(keywordHits: KeywordHit[]) {
  download(
    'keyword-hits.csv',
    toCsv(
      keywordHits.map((hit) => ({
        phrase: hit.phrase,
        category: hit.category,
        contact: hit.contact,
        timestamp: hit.timestamp,
        excerpt: hit.excerpt,
      })),
    ),
    'text/csv;charset=utf-8',
  )
}

export function downloadContactsCsv(contacts: ContactSummary[]) {
  download(
    'contacts.csv',
    toCsv(
      contacts.map((contact) => ({
        name: contact.name,
        interactions: contact.interactions,
        messageCount: contact.messageCount,
        searchCount: contact.searchCount,
        friendEventCount: contact.friendEventCount,
        lateNightInteractions: contact.lateNightInteractions,
        keywordHits: contact.keywordHits,
        uploads: contact.uploads,
        activeDays: contact.activeDays,
        recentChange: contact.recentChange,
        deletionIndicators: contact.deletionIndicators,
        romanticScore: contact.romanticScore,
        secrecyScore: contact.secrecyScore,
        intensityScore: contact.intensityScore,
        missingChat: contact.missingChat ? 'yes' : 'no',
        peakHour: contact.peakHour,
        peakWeekday: contact.peakWeekday,
        firstSeen: contact.firstSeen,
        lastSeen: contact.lastSeen,
      })),
    ),
    'text/csv;charset=utf-8',
  )
}

export function downloadWorkspaceReport(workspace: WorkspaceDataset) {
  download(
    'workspace-report.json',
    JSON.stringify(buildWorkspaceReport(workspace), null, 2),
    'application/json;charset=utf-8',
  )
}
