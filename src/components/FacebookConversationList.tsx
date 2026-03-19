import { useMemo } from 'react'
import type { NormalizedEvent } from '../types'
import { sanitizeFacebookTranscriptText, splitFacebookTranscriptBlocks } from '../lib/facebookTranscript'

type ThreadSort = 'newest' | 'oldest'
type ConversationRole = 'self' | 'contact' | 'system'

type FacebookTurn = {
  key: string
  event: NormalizedEvent
  role: ConversationRole
  actor: string
  timestamp: string | null
  dayKey: string
  category: string
  sourceFile: string
  text: string
  unresolved: boolean
}

type Props = {
  aliasIndex: Map<string, Set<string>>
  events: NormalizedEvent[]
  onEventClick: (eventId: string) => void
  sortOrder: ThreadSort
  terms: string[]
}

function compact(value: string | null | undefined) {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

function formatFacebookDay(value: string | null) {
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

function formatFacebookTimestamp(value: string | null) {
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

function normalizeAlias(value: string) {
  return value.toLowerCase().trim()
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

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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

function buildTurns(events: NormalizedEvent[], aliasIndex: Map<string, Set<string>>, sortOrder: ThreadSort) {
  return sortThreadEvents(events, sortOrder).flatMap((event) => {
    const role = resolveConversationRole(event, aliasIndex)
    const actor = extractActorValue(event) ?? (role === 'self' ? 'You' : event.contact ?? 'Unknown')
    const rawText = sanitizeFacebookTranscriptText(event.text ?? event.detail ?? event.evidenceText)
    const blocks = event.category === 'chat' ? splitFacebookTranscriptBlocks(rawText) : []
    const fallbackBlock = {
      timestamp: event.timestamp ?? null,
      actor,
      text: rawText,
      unresolved: rawText.length === 0,
    }

    const sourceBlocks = blocks.length
      ? blocks
      : [fallbackBlock]

    return sourceBlocks.map((block, blockIndex) => {
      const timestamp = block.timestamp ?? event.timestamp ?? null
      const text = compact(block.text)
      return {
        key: `${event.id}-${blockIndex}`,
        event,
        role,
        actor: block.actor ?? actor,
        timestamp,
        dayKey: timestamp?.slice(0, 10) ?? `undated-${event.id}-${blockIndex}`,
        category: event.category,
        sourceFile: event.sourceFile,
        text,
        unresolved: block.unresolved || text.length === 0,
      } satisfies FacebookTurn
    })
  })
}

export function FacebookConversationList(props: Props) {
  const turns = useMemo(
    () => buildTurns(props.events, props.aliasIndex, props.sortOrder),
    [props.aliasIndex, props.events, props.sortOrder],
  )

  return (
    <div className="facebook-conversation-list">
      {turns.map((turn, index) => {
        const previousDayKey = turns[index - 1]?.dayKey ?? null
        const showDay = index === 0 || turn.dayKey !== previousDayKey

        return (
          <div className={`facebook-conversation-item role-${turn.role}`} key={turn.key}>
            {showDay ? <div className="facebook-day-separator">{formatFacebookDay(turn.timestamp)}</div> : null}
            <button
              className={`facebook-turn-card role-${turn.role}`}
              onClick={() => props.onEventClick(turn.event.id)}
              type="button"
            >
              <div className="facebook-turn-head">
                <div className="facebook-turn-identity">
                  <strong className="facebook-turn-actor">{turn.actor}</strong>
                  <span className="facebook-turn-time">{formatFacebookTimestamp(turn.timestamp)}</span>
                </div>
                <div className="facebook-turn-meta">
                  <span className="message-type">{turn.category}</span>
                  <span className="facebook-turn-source mono">
                    [{turn.event.id}] {turn.sourceFile}
                  </span>
                </div>
              </div>
              <div className="facebook-turn-body">
                {turn.text ? (
                  <HighlightedText terms={props.terms} text={turn.text} />
                ) : (
                  <span className="muted-text">
                    {turn.unresolved
                      ? 'No readable text was recovered for this timestamp.'
                      : 'No readable chat text was recovered for this row.'}
                  </span>
                )}
              </div>
            </button>
          </div>
        )
      })}
    </div>
  )
}
