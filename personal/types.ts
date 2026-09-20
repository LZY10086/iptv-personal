import type { StreamTesterResult } from '../scripts/core/streamTester'
import type { Stream } from '../scripts/models'

export type PersonalPlaylistConfig = {
  sources: string[]
  outputDirectory: string
  downloadTimeoutMs: number
  filters: {
    countries: string[]
    languages: string[]
    categories: string[]
    includeNames: string[]
    excludeNames: string[]
    excludeLabels: string[]
    minimumVerticalResolution: number
  }
  availability: {
    enabled: boolean
    parallel: number
    timeoutMs: number
    rejectStatusCodes: string[]
  }
  safety: {
    minimumOutputStreams: number
  }
}

export type AvailabilitySummary = {
  checked: number
  rejected: number
  retainedWithWarning: number
  statusCounts: Record<string, number>
}

export type AvailabilityResult = {
  streams: Stream[]
  summary: AvailabilitySummary
}

export type StreamTesterLike = {
  test(stream: Stream): Promise<StreamTesterResult>
}

export type SourceReport = {
  source: string
  streams: number
}

export type GenerationReport = {
  generatedAt: string
  scheduleTimeZone: string
  sources: SourceReport[]
  downloadedStreams: number
  matchedStreams: number
  deduplicatedStreams: number
  outputStreams: number
  availability: AvailabilitySummary
}
