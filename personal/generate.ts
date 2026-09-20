import { Collection, Logger } from '@freearhey/core'
import { Storage } from '@freearhey/storage-js'
import axios from 'axios'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { data, downloadData, loadData } from '../scripts/api'
import { PlaylistParser, StreamTester } from '../scripts/core'
import { Playlist, Stream } from '../scripts/models'
import { deduplicateStreams, matchesFilters, sortStreams, testAvailability } from './playlist'
import type { GenerationReport, PersonalPlaylistConfig, SourceReport } from './types'

const DEFAULT_CONFIG_PATH = 'personal/config.json'
const PLAYLIST_FILENAME = 'playlist.m3u'
const REPORT_FILENAME = 'report.json'
const logger = new Logger()

/** Generates the personal playlist from remote public playlists. */
async function main() {
  const projectRoot = process.cwd()
  const configPath = path.resolve(projectRoot, process.argv[2] || DEFAULT_CONFIG_PATH)
  const config = await loadConfig(configPath)
  const runtimeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'iptv-personal-'))

  try {
    logger.info('Refreshing iptv-org metadata...')
    await downloadData()
    await loadData()

    logger.info(`Downloading ${config.sources.length} playlist source(s)...`)
    const downloaded = await downloadAndParseSources(config, runtimeDirectory)
    const downloadedStreams = downloaded.streams.length

    preparePublicMetadata(downloaded.streams)
    const matched = downloaded.streams.filter(function filterStream(stream) {
      return matchesFilters(stream, config.filters)
    })
    const deduplicated = deduplicateStreams(matched)

    logger.info(`Checking ${deduplicated.length} filtered stream(s)...`)
    const tester = new StreamTester({
      options: {
        timeout: config.availability.timeoutMs,
        proxy: undefined
      }
    })
    const availability = await testAvailability(deduplicated, config.availability, tester)
    const outputStreams = sortStreams(availability.streams)
    ensureSafeOutput(outputStreams, config)

    const report: GenerationReport = {
      generatedAt: new Date().toISOString(),
      scheduleTimeZone: 'Asia/Shanghai',
      sources: downloaded.sources,
      downloadedStreams,
      matchedStreams: matched.length,
      deduplicatedStreams: deduplicated.length,
      outputStreams: outputStreams.length,
      availability: availability.summary
    }

    const playlist = new Playlist(new Collection<Stream>(outputStreams), {
      public: true,
      raw: true
    }).toString()
    const outputDirectory = path.resolve(projectRoot, config.outputDirectory)
    await writeOutputs(outputDirectory, playlist, report)

    logger.info(`Generated ${outputStreams.length} stream(s) in ${config.outputDirectory}`)
  } finally {
    await fs.rm(runtimeDirectory, { recursive: true, force: true })
  }
}

/** Reads and validates the user-editable JSON configuration. */
async function loadConfig(configPath: string): Promise<PersonalPlaylistConfig> {
  const content = await fs.readFile(configPath, 'utf8')
  const config = JSON.parse(content) as PersonalPlaylistConfig

  if (!Array.isArray(config.sources) || !config.sources.length) {
    throw new Error('At least one playlist source is required')
  }
  for (const source of config.sources) validateSourceUrl(source)
  if (!config.outputDirectory) throw new Error('outputDirectory is required')
  if (!Number.isInteger(config.downloadTimeoutMs) || config.downloadTimeoutMs < 1000) {
    throw new Error('downloadTimeoutMs must be an integer greater than or equal to 1000')
  }
  if (!Number.isInteger(config.availability.parallel) || config.availability.parallel < 1) {
    throw new Error('availability.parallel must be a positive integer')
  }
  if (!Number.isInteger(config.availability.timeoutMs) || config.availability.timeoutMs < 1000) {
    throw new Error('availability.timeoutMs must be an integer greater than or equal to 1000')
  }
  if (
    !Number.isInteger(config.safety.minimumOutputStreams) ||
    config.safety.minimumOutputStreams < 1
  ) {
    throw new Error('safety.minimumOutputStreams must be a positive integer')
  }

  return config
}

/** Accepts only HTTP(S) playlist sources. */
function validateSourceUrl(source: string) {
  const url = new URL(source)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Playlist sources must use HTTP or HTTPS')
  }
}

/** Downloads sources into isolated storage and parses them with the upstream parser. */
async function downloadAndParseSources(
  config: PersonalPlaylistConfig,
  runtimeDirectory: string
): Promise<{ streams: Stream[]; sources: SourceReport[] }> {
  const storage = new Storage(runtimeDirectory)
  const parser = new PlaylistParser({ storage })
  const streams: Stream[] = []
  const sources: SourceReport[] = []

  for (let index = 0; index < config.sources.length; index++) {
    const source = config.sources[index]
    const filename = `source-${index + 1}.m3u`
    const content = await downloadSource(source, index, config.downloadTimeoutMs)
    await storage.save(filename, content)

    const parsed = await parser.parseFile(filename)
    streams.push(...parsed.all())
    sources.push({
      source: sanitizeSourceUrl(source),
      streams: parsed.count()
    })
  }

  return { streams, sources }
}

/** Downloads one M3U file while avoiding secrets in user-facing errors. */
async function downloadSource(source: string, index: number, timeoutMs: number): Promise<string> {
  try {
    const response = await axios.get<string>(source, {
      responseType: 'text',
      timeout: timeoutMs,
      maxContentLength: 50 * 1024 * 1024,
      headers: {
        'User-Agent': 'iptv-personal-playlist/1.0'
      }
    })
    const content = response.data
    if (typeof content !== 'string' || !content.trimStart().startsWith('#EXTM3U')) {
      throw new Error('Response is not an M3U playlist')
    }

    return content
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown download error'
    throw new Error(`Unable to download source ${index + 1} (${sanitizeSourceUrl(source)}): ${reason}`)
  }
}

/** Adds guide and category metadata needed by the public M3U serializer. */
function preparePublicMetadata(streams: Stream[]) {
  for (const stream of streams) {
    stream.setGuides(data.guidesGroupedByStreamId.get(stream.getId()))
    const groupTitle = stream
      .getCategories()
      .map(function getCategoryName(category) {
        return category.name
      })
      .sort()
      .join(';')
    stream.groupTitle = groupTitle || 'Undefined'
  }
}

/** Prevents a failed or over-restrictive run from replacing the last good output. */
function ensureSafeOutput(streams: Stream[], config: PersonalPlaylistConfig) {
  if (streams.length >= config.safety.minimumOutputStreams) return

  throw new Error(
    `Output contains ${streams.length} stream(s), below safety.minimumOutputStreams=${config.safety.minimumOutputStreams}`
  )
}

/** Writes report first and playlist last so readers keep the previous good playlist on failure. */
async function writeOutputs(
  outputDirectory: string,
  playlist: string,
  report: GenerationReport
) {
  await fs.mkdir(outputDirectory, { recursive: true })
  await writeFileAtomically(
    path.join(outputDirectory, REPORT_FILENAME),
    JSON.stringify(report, null, 2) + os.EOL
  )
  await writeFileAtomically(path.join(outputDirectory, PLAYLIST_FILENAME), playlist)
}

/** Replaces one output only after its complete temporary file has been written. */
async function writeFileAtomically(filepath: string, content: string) {
  const temporaryFilepath = `${filepath}.${process.pid}.tmp`
  try {
    await fs.writeFile(temporaryFilepath, content, 'utf8')
    await fs.rename(temporaryFilepath, filepath)
  } finally {
    await fs.rm(temporaryFilepath, { force: true })
  }
}

/** Removes credentials and query parameters from reports and errors. */
function sanitizeSourceUrl(source: string): string {
  const url = new URL(source)
  return `${url.protocol}//${url.host}${url.pathname}`
}

main().catch(function handleFailure(error: unknown) {
  const details = error instanceof Error ? error.stack || error.message : String(error)
  logger.error(`Personal playlist generation failed\n${details}`)
  process.exitCode = 1
})
