export type Platform = 'snapchat' | 'facebook'

export type DataCategory =
  | 'account'
  | 'bitmoji'
  | 'chat'
  | 'event'
  | 'friend'
  | 'group'
  | 'location'
  | 'login'
  | 'memory'
  | 'page'
  | 'post'
  | 'purchase'
  | 'reaction'
  | 'search'
  | 'support'
  | 'unknown'

export type NormalizedValue = string | number | boolean | null

export type AccountProfile = {
  username: string | null
  displayName: string | null
  email: string | null
  phone: string | null
  region: string | null
  aliases: string[]
}

export type UploadSummary = {
  id: string
  fileName: string
  sizeBytes: number
  uploadedAt: string
  processedAt: string
  totalFiles: number
  supportedFiles: number
  unsupportedFiles: number
  categoryCounts: Partial<Record<DataCategory, number>>
  account: AccountProfile
  warnings: string[]
}

export type FileSummary = {
  uploadId: string
  path: string
  extension: string
  category: DataCategory
  rows: number
  supported: boolean
}

export type NormalizedEvent = {
  id: string
  uploadId: string
  category: DataCategory
  subtype: string | null
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
  evidenceText: string
  attributes: Record<string, NormalizedValue>
}

export type ParsedUpload = {
  upload: UploadSummary
  fileSummaries: FileSummary[]
  events: NormalizedEvent[]
}

export type KeywordHit = {
  phrase: string
  category: string
  contact: string
  timestamp: string | null
  excerpt: string
  eventId: string
}

export type ContactSummary = {
  name: string
  interactions: number
  messageCount: number
  searchCount: number
  friendEventCount: number
  lateNightInteractions: number
  keywordHits: number
  uploads: number
  activeDays: number
  firstSeen: string | null
  lastSeen: string | null
  recentChange: number
  deletionIndicators: number
  romanticScore: number
  secrecyScore: number
  intensityScore: number
  missingChat: boolean
  peakHour: number | null
  peakWeekday: string | null
  categoryCounts: Partial<Record<DataCategory, number>>
  topPhrases: string[]
  topToneLabels: string[]
  evidenceIds: string[]
}

export type SignalFinding = {
  id: string
  title: string
  type: string
  severity: 'low' | 'medium' | 'high'
  score: number
  summary: string
  explanation: string
  evidenceIds: string[]
}

export type EntitySummary = {
  id: string
  type: 'person' | 'name' | 'handle' | 'email' | 'phone' | 'link' | 'location' | 'username'
  value: string
  count: number
  contacts: string[]
  uploads: string[]
  evidenceIds: string[]
}

export type PhrasePattern = {
  phrase: string
  count: number
  contacts: string[]
  evidenceIds: string[]
}

export type ToneSummary = {
  category: string
  label: string
  count: number
  contacts: string[]
  evidenceIds: string[]
}

export type TimelineBucket = {
  key: string
  label: string
  count: number
  categories: Partial<Record<DataCategory, number>>
  evidenceIds: string[]
}

export type HourBucket = {
  hour: number
  count: number
}

export type WeekdayBucket = {
  day: number
  label: string
  count: number
}

export type HeatmapCell = {
  day: number
  hour: number
  count: number
}

export type NotablePeriod = {
  id: string
  label: string
  start: string
  end: string
  summary: string
  evidenceIds: string[]
}

export type EvidenceSnippet = {
  eventId: string
  uploadId: string
  label: string
  timestamp: string | null
  sourceFile: string
  excerpt: string
}

export type DatasetStats = {
  totalEvents: number
  chatEvents: number
  locationEvents: number
  loginEvents: number
  searchEvents: number
  memoryEvents: number
  uniqueContacts: number
  uniqueEntities: number
  uploads: number
  supportedFiles: number
  unsupportedFiles: number
  missingChatContacts: number
  deletionIndicators: number
  dateRange: {
    start: string | null
    end: string | null
  }
}

export type WorkspaceDataset = {
  uploads: UploadSummary[]
  fileSummaries: FileSummary[]
  events: NormalizedEvent[]
  stats: DatasetStats
  accountProfiles: AccountProfile[]
  contacts: ContactSummary[]
  keywordHits: KeywordHit[]
  signals: SignalFinding[]
  entities: EntitySummary[]
  repeatedPhrases: PhrasePattern[]
  toneSummaries: ToneSummary[]
  timeline: TimelineBucket[]
  hourBuckets: HourBucket[]
  weekdayBuckets: WeekdayBucket[]
  heatmap: HeatmapCell[]
  notablePeriods: NotablePeriod[]
  evidenceSnippets: EvidenceSnippet[]
  factsSummary: string[]
  warnings: string[]
}

export type AIProvider = 'gemini' | 'openai'

export type AISettings = {
  provider: AIProvider
  apiKey: string
  model: string
}

export type AIResult = {
  provider: AIProvider
  model: string
  createdAt: string
  question: string
  answer: string
}
