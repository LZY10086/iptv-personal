import { describe, expect, it } from 'vitest'
import type { Stream } from '../../scripts/models'
import { deduplicateStreams, matchesFilters, sortStreams, testAvailability } from '../../personal/playlist'
import type { PersonalPlaylistConfig, StreamTesterLike } from '../../personal/types'

const filters: PersonalPlaylistConfig['filters'] = {
  countries: ['CN'],
  languages: ['zho'],
  categories: ['news'],
  includeNames: ['demo'],
  excludeNames: ['blocked'],
  excludeLabels: ['Geo-blocked'],
  minimumVerticalResolution: 720
}

describe('personal playlist', () => {
  it('matches every configured filter dimension', () => {
    expect(matchesFilters(createStream(), filters)).toBe(true)
    expect(matchesFilters(createStream({ labels: ['Geo-blocked'] }), filters)).toBe(false)
    expect(matchesFilters(createStream({ title: 'Blocked Demo' }), filters)).toBe(false)
    expect(matchesFilters(createStream({ resolution: 576 }), filters)).toBe(false)
  })

  it('deduplicates by tvg-id and falls back to URL', () => {
    const streams = [
      createStream({ tvgId: 'demo.cn@SD', url: 'https://example.com/1.m3u8' }),
      createStream({ tvgId: 'demo.cn@SD', url: 'https://example.com/2.m3u8' }),
      createStream({ tvgId: '', url: 'https://example.com/3.m3u8' }),
      createStream({ tvgId: '', url: 'https://example.com/3.m3u8' })
    ]

    expect(deduplicateStreams(streams)).toHaveLength(2)
  })

  it('sorts by group and title without mutating input', () => {
    const streams = [
      createStream({ groupTitle: 'News', title: 'Zulu' }),
      createStream({ groupTitle: 'General', title: 'Alpha' })
    ]

    const sorted = sortStreams(streams)

    expect(sorted.map(stream => stream.title)).toEqual(['Alpha', 'Zulu'])
    expect(streams[0].title).toBe('Zulu')
  })

  it('rejects hard failures and retains uncertain results', async () => {
    const streams = [
      createStream({ url: 'https://example.com/ok.m3u8' }),
      createStream({ url: 'https://example.com/missing.m3u8' }),
      createStream({ url: 'https://example.com/timeout.m3u8' })
    ]
    const tester: StreamTesterLike = {
      async test(stream) {
        const code = stream.url.includes('missing')
          ? 'HTTP_404_NOT_FOUND'
          : stream.url.includes('timeout')
            ? 'TIMEOUT'
            : 'OK'
        return { status: { ok: code === 'OK', code } }
      }
    }
    const result = await testAvailability(
      streams,
      {
        enabled: true,
        parallel: 2,
        timeoutMs: 1000,
        rejectStatusCodes: ['HTTP_404_NOT_FOUND']
      },
      tester
    )

    expect(result.streams.map(stream => stream.url)).toEqual([
      'https://example.com/ok.m3u8',
      'https://example.com/timeout.m3u8'
    ])
    expect(result.summary).toMatchObject({
      checked: 3,
      rejected: 1,
      retainedWithWarning: 1
    })
  })
})

type StreamOverrides = {
  tvgId?: string
  url?: string
  title?: string
  groupTitle?: string
  labels?: string[]
  resolution?: number
}

/** Creates the narrow Stream surface required by personal playlist tests. */
function createStream(overrides: StreamOverrides = {}): Stream {
  const tvgId = overrides.tvgId === undefined ? 'demo.cn@SD' : overrides.tvgId
  const url = overrides.url || 'https://example.com/demo.m3u8'
  const title = overrides.title || 'Demo News'
  const groupTitle = overrides.groupTitle || 'News'
  const labels = overrides.labels || []
  const resolution = overrides.resolution === undefined ? 1080 : overrides.resolution

  return {
    tvgId,
    url,
    title,
    channelName: title,
    groupTitle,
    getTvgId() {
      return tvgId
    },
    getBroadcastCountries() {
      return collection([{ code: 'CN' }])
    },
    getLanguages() {
      return collection([{ code: 'zho' }])
    },
    getCategories() {
      return collection([{ id: 'news', name: 'News' }])
    },
    getLabels() {
      return labels
    },
    getVerticalResolution() {
      return resolution
    }
  } as unknown as Stream
}

/** Creates the Collection method surface used by filter functions. */
function collection<T>(items: T[]) {
  return {
    all() {
      return items
    }
  }
}
