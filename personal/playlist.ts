import type { Stream } from '../scripts/models'
import type {
  AvailabilityResult,
  PersonalPlaylistConfig,
  StreamTesterLike
} from './types'

/** Checks whether a stream satisfies every configured filter dimension. */
export function matchesFilters(
  stream: Stream,
  filters: PersonalPlaylistConfig['filters']
): boolean {
  if (!matchesCountries(stream, filters.countries)) return false
  if (!matchesLanguages(stream, filters.languages)) return false
  if (!matchesCategories(stream, filters.categories)) return false
  if (!matchesIncludedName(stream, filters.includeNames)) return false
  if (matchesExcludedName(stream, filters.excludeNames)) return false
  if (hasExcludedLabel(stream, filters.excludeLabels)) return false

  return stream.getVerticalResolution() >= filters.minimumVerticalResolution
}

/** Keeps the first stream for each channel/feed identifier or URL fallback. */
export function deduplicateStreams(streams: Stream[]): Stream[] {
  const seen = new Set<string>()
  const unique: Stream[] = []

  for (const stream of streams) {
    const tvgId = stream.getTvgId().trim()
    const key = tvgId ? `id:${normalize(tvgId)}` : `url:${stream.url.trim()}`
    if (seen.has(key)) continue

    seen.add(key)
    unique.push(stream)
  }

  return unique
}

/** Sorts output deterministically by group and display title. */
export function sortStreams(streams: Stream[]): Stream[] {
  return [...streams].sort(function compareStreams(left, right) {
    const groupComparison = left.groupTitle.localeCompare(right.groupTitle, 'en')
    if (groupComparison !== 0) return groupComparison

    return left.title.localeCompare(right.title, 'en')
  })
}

/** Applies bounded availability checks and only rejects configured hard failures. */
export async function testAvailability(
  streams: Stream[],
  settings: PersonalPlaylistConfig['availability'],
  tester: StreamTesterLike
): Promise<AvailabilityResult> {
  if (!settings.enabled) {
    return {
      streams,
      summary: {
        checked: 0,
        rejected: 0,
        retainedWithWarning: 0,
        statusCounts: {}
      }
    }
  }

  const statuses = new Array<string>(streams.length)
  let cursor = 0

  /** Claims indexes serially so workers do not test the same stream. */
  async function runWorker() {
    while (cursor < streams.length) {
      const index = cursor
      cursor++

      try {
        const result = await tester.test(streams[index])
        statuses[index] = result.status.code
      } catch {
        statuses[index] = 'TEST_ERROR'
      }
    }
  }

  const workers: Promise<void>[] = []
  const workerCount = Math.min(settings.parallel, streams.length)
  for (let index = 0; index < workerCount; index++) {
    workers.push(runWorker())
  }
  await Promise.all(workers)

  const rejectCodes = new Set(settings.rejectStatusCodes)
  const retained: Stream[] = []
  const statusCounts: Record<string, number> = {}
  let rejected = 0
  let retainedWithWarning = 0

  for (let index = 0; index < streams.length; index++) {
    const status = statuses[index] || 'TEST_ERROR'
    statusCounts[status] = (statusCounts[status] || 0) + 1

    if (rejectCodes.has(status)) {
      rejected++
      continue
    }

    if (status !== 'OK') retainedWithWarning++
    retained.push(streams[index])
  }

  return {
    streams: retained,
    summary: {
      checked: streams.length,
      rejected,
      retainedWithWarning,
      statusCounts
    }
  }
}

/** Matches a stream against optional ISO 3166-1 alpha-2 country codes. */
function matchesCountries(stream: Stream, configured: string[]): boolean {
  if (!configured.length) return true

  const allowed = new Set(configured.map(normalize))
  return stream
    .getBroadcastCountries()
    .all()
    .some(function hasCountry(country) {
      return allowed.has(normalize(country.code))
    })
}

/** Matches a stream against optional ISO 639-3 language codes. */
function matchesLanguages(stream: Stream, configured: string[]): boolean {
  if (!configured.length) return true

  const allowed = new Set(configured.map(normalize))
  return stream
    .getLanguages()
    .all()
    .some(function hasLanguage(language) {
      return allowed.has(normalize(language.code))
    })
}

/** Matches category identifiers or names case-insensitively. */
function matchesCategories(stream: Stream, configured: string[]): boolean {
  if (!configured.length) return true

  const allowed = new Set(configured.map(normalize))
  return stream
    .getCategories()
    .all()
    .some(function hasCategory(category) {
      return allowed.has(normalize(category.id)) || allowed.has(normalize(category.name))
    })
}

/** Requires at least one configured name fragment when an include list exists. */
function matchesIncludedName(stream: Stream, configured: string[]): boolean {
  if (!configured.length) return true

  return containsConfiguredName(stream, configured)
}

/** Detects a configured excluded name fragment. */
function matchesExcludedName(stream: Stream, configured: string[]): boolean {
  if (!configured.length) return false

  return containsConfiguredName(stream, configured)
}

/** Searches normalized title and channel metadata for configured fragments. */
function containsConfiguredName(stream: Stream, configured: string[]): boolean {
  const searchable = normalize(
    [stream.title, stream.channelName, stream.getTvgId()].filter(Boolean).join(' ')
  )

  return configured.some(function containsName(fragment) {
    return searchable.includes(normalize(fragment))
  })
}

/** Detects labels such as Geo-blocked and Not 24/7. */
function hasExcludedLabel(stream: Stream, configured: string[]): boolean {
  if (!configured.length) return false

  const excluded = new Set(configured.map(normalize))
  return stream.getLabels().some(function containsLabel(label) {
    return excluded.has(normalize(label))
  })
}

/** Normalizes human-entered filter values for stable comparisons. */
function normalize(value: string): string {
  return value.trim().toLocaleLowerCase('en')
}
