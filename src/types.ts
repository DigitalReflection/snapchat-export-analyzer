export type DataCategory =
  | 'chat'
  | 'friend'
  | 'location'
  | 'login'
  | 'memory'
  | 'search'
  | 'unknown'

export type NormalizedEvent = {
  id: string
  category: DataCategory
  sourceFile: string
  timestamp: string | null
  contact: string | null
  text: string | null
  detail: string | null
  locationName: string | null
  latitude: number | null
  longitude: number | null
  device: string | null
  region: string | null
}

export type ParsedDataset = {
  events: NormalizedEvent[]
  fileSummaries: FileSummary[]
  contacts: ContactSummary[]
  keywordHits: KeywordHit[]
  signals: SignalFinding[]
  stats: DatasetStats
}

export type FileSummary = {
  path: string
  category: DataCategory
  rows: number
}

export type ContactSummary = {
  name: string
  interactions: number
  firstSeen: string | null
  lastSeen: string | null
  lateNightInteractions: number
  keywordHits: number
}

export type KeywordHit = {
  phrase: string
  contact: string
  timestamp: string | null
  excerpt: string
}

export type SignalFinding = {
  title: string
  severity: 'low' | 'medium' | 'high'
  summary: string
}

export type DatasetStats = {
  totalEvents: number
  chatEvents: number
  locationEvents: number
  loginEvents: number
  searchEvents: number
  memoryEvents: number
  uniqueContacts: number
}
