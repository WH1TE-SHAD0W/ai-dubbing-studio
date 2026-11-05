#!/usr/bin/env node
// ADR-0019 spike: measure how much RAM a translator worker uses, Go vs Node.
//
//   node benchmarks/runtime-test/measure.mjs --runtime go|node [--scenario idle|live]
//        [--runs 3] [--minutes 5] [--window 3] [--tag name] [--gomaxprocs N]
//
// --scenario idle (default): the worker waits for a job that never comes.
// --scenario live: the worker gets one job and serves one live track for --minutes. A host
//   publishes recorded speech (harness/audio/speech.wav) into the source room first; the
//   worker joins both rooms, streams the host's audio to the real Gemini Live API and
//   publishes the translation, and a listener checks that it arrives. At the end the rooms
//   are deleted (the session ends) and the worker exits. GEMINI_API_KEY and GEMINI_MODEL come
//   from the repo-root .env (only those two are passed on; the key is never printed).
//   Every minute of a live run is a paid Gemini stream.
// --tag keeps a variant's results apart (results/<runtime>-<tag>-<scenario>-<n>.csv and
// its own summary row); --gomaxprocs sets GOMAXPROCS in the Go container.
//
// For each run it starts a fresh worker container (Redis must answer first), times
// container start → the worker's "ready" log line, then samples for --minutes:
//   - every second, from the Docker Engine API (outside the container, so sampling adds
//     nothing to it): the memory working set (cgroup memory.current minus inactive_file,
//     the number kubelet, `kubectl top` and `docker stats` show), anon and file memory, CPU;
//   - every 5 seconds, the worker's /metrics: process RSS and the runtime heap;
//   - once at the end, /proc/1/status: RssAnon (the process's own memory) and RssFile
//     (mapped file pages: the binary and shared libraries, shared between pods).
// It writes results/<runtime>[-<tag>]-<scenario>-<n>.csv, and keeps results/summary.json and
// results/summary.md up to date with the medians over the last --window minutes.
// No dependencies: plain Node 24.
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import http from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createGzip } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const resultsDir = join(here, 'results')
const compose = ['compose', '-f', join(here, 'docker-compose.yml')]

const { values: args } = parseArgs({
  options: {
    runtime: { type: 'string' },
    scenario: { type: 'string', default: 'idle' },
    runs: { type: 'string', default: '3' },
    minutes: { type: 'string', default: '5' },
    window: { type: 'string', default: '3' },
    tag: { type: 'string', default: '' },
    gomaxprocs: { type: 'string', default: '' },
  },
})
const runtime = args.runtime
const scenario = args.scenario
if ((runtime !== 'go' && runtime !== 'node') || !['idle', 'live'].includes(scenario)) {
  console.error(
    'usage: node measure.mjs --runtime go|node [--scenario idle|live] [--runs 3] [--minutes 5] [--window 3] [--tag name] [--gomaxprocs N]',
  )
  process.exit(2)
}
const runs = Number(args.runs)
const minutes = Number(args.minutes)
const windowMin = Math.min(Number(args.window), minutes)
const base = args.tag ? `${runtime}-${args.tag}` : runtime
// Summary key: idle rows keep the plain name; live rows get -live.
const key = scenario === 'idle' ? base : `${base}-live`
// docker-compose.yml passes GOMAXPROCS through to the Go worker; empty means the Go default.
process.env.GOMAXPROCS = args.gomaxprocs
if (scenario === 'live') {
  if (!existsSync(join(here, 'harness', 'audio', 'speech.wav'))) {
    console.error('--scenario live needs harness/audio/speech.wav: run harness/make-speech-wav.ps1 (Windows) or add a PCM16 mono WAV')
    process.exit(2)
  }
  // Only the two Gemini settings go to the worker container (through docker-compose.yml).
  const dotenv = join(here, '..', '..', '.env')
  const text = existsSync(dotenv) ? readFileSync(dotenv, 'utf8') : ''
  for (const name of ['GEMINI_API_KEY', 'GEMINI_MODEL']) {
    const m = text.match(new RegExp(`^${name}=(.*)$`, 'm'))
    if (!process.env[name] && m) process.env[name] = m[1].trim().replace(/^["']|["']$/g, '')
  }
  if (!process.env.GEMINI_API_KEY) {
    console.error('--scenario live needs GEMINI_API_KEY in the repo-root .env (or the environment)')
    process.exit(2)
  }
}
const service = `worker-${runtime}`
const container = `spike-worker-${runtime}`
const image = `ads-spike-worker-${runtime}`
const metricsUrl = `http://127.0.0.1:${runtime === 'go' ? 18081 : 18082}/metrics`

const docker = (...a) => execFileSync('docker', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MiB = (b) => (b == null ? '' : (b / 1024 / 1024).toFixed(1))
const median = (xs) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b)
  if (!s.length) return null
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// ---- Docker Engine API (named pipe on Windows, unix socket elsewhere) ----
function engineSocket() {
  const host = docker('context', 'inspect', '--format', '{{.Endpoints.docker.Host}}')
  if (host.startsWith('npipe://')) return host.slice('npipe://'.length).replaceAll('/', '\\')
  if (host.startsWith('unix://')) return host.slice('unix://'.length)
  throw new Error(`unsupported Docker endpoint ${host}`)
}
const socketPath = engineSocket()
function engineGet(path) {
  return new Promise((resolve, reject) => {
    http
      .get({ socketPath, path }, (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => (res.statusCode === 200 ? resolve(JSON.parse(body)) : reject(new Error(`${res.statusCode} ${body}`))))
      })
      .on('error', reject)
  })
}

// ---- the worker's own /metrics ----
async function scrape() {
  try {
    const text = await (await fetch(metricsUrl, { signal: AbortSignal.timeout(2000) })).text()
    const get = (name) => {
      const m = text.match(new RegExp(`^${name}(?:\\{[^}]*\\})? ([0-9.e+]+)$`, 'm'))
      return m ? Number(m[1]) : null
    }
    return {
      rss: get('process_resident_memory_bytes'),
      heap: runtime === 'go' ? get('go_memstats_heap_inuse_bytes') : get('nodejs_heap_size_used_bytes'),
      external: runtime === 'node' ? get('nodejs_external_memory_bytes') : null,
      samplesIn: get('translator_samples_in_total'),
      samplesOut: get('translator_samples_out_total'),
    }
  } catch {
    return { rss: null, heap: null, external: null, samplesIn: null, samplesOut: null }
  }
}

const live = (...a) => docker(...compose, '--profile', runtime, '--profile', 'live', ...a)
const parseLines = (text) =>
  text.split('\n').flatMap((line) => {
    try {
      return [JSON.parse(line)]
    } catch {
      return []
    }
  })

/** The JSON log lines of the worker container or of a harness service. */
const jsonLogs = (source) =>
  parseLines(source === container ? docker('logs', container) : live('logs', '--no-log-prefix', source))

/** Wait for a log line with this msg (and matching test); returns the line. */
async function waitForLog(source, msg, timeoutMs = 60_000, test = () => true) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const hit = jsonLogs(source).find((j) => j.msg === msg && test(j))
    if (hit) return hit
    await sleep(100)
  }
  throw new Error(`${source} did not log "${msg}" within ${timeoutMs / 1000}s`)
}

async function oneRun(n) {
  docker(...compose, '--profile', runtime, 'rm', '-sf', service)
  if (scenario === 'live') {
    live('rm', '-sf', 'host', 'listener')
    live('up', '-d', '--wait', 'redis', 'livekit')
  } else {
    docker(...compose, '--profile', runtime, 'up', '-d', '--wait', 'redis')
  }
  docker(...compose, '--profile', runtime, 'up', '-d', '--no-deps', '--no-build', service)
  const startedAt = new Date(docker('inspect', '-f', '{{.State.StartedAt}}', container))
  const readyMs = new Date((await waitForLog(container, 'ready')).time).getTime() - startedAt.getTime()
  console.log(`[${key} #${n}] ready ${readyMs} ms after container start`)

  let jobToLiveMs = null
  if (scenario === 'live') {
    // The host is in the source room before the job is sent, as in pod-spec §3.1.
    live('up', '-d', '--no-deps', 'host')
    await waitForLog('host', 'publishing')
    live('run', '--rm', '--no-deps', 'tools', 'node', 'dispatch.ts', 'start', container)
    const received = await waitForLog(container, 'job_received')
    const isLive = await waitForLog(container, 'live', 60_000)
    jobToLiveMs = new Date(isLive.time).getTime() - new Date(received.time).getTime()
    live('up', '-d', '--no-deps', 'listener')
    console.log(`[${key} #${n}] live ${jobToLiveMs} ms after the job arrived`)
  }
  console.log(`[${key} #${n}] sampling ${minutes} min`)

  const rows = []
  const t0 = Date.now()
  let prev = null
  let last = { rss: null, heap: null, external: null, samplesIn: null, samplesOut: null }
  for (let i = 0; Date.now() - t0 < minutes * 60_000; i++) {
    const tick = t0 + i * 1000
    const s = await engineGet(`/containers/${container}/stats?stream=false&one-shot=true`)
    const ms = s.memory_stats
    const workingSet = ms.usage - (ms.stats?.inactive_file ?? 0)
    const cpuTotal = s.cpu_stats.cpu_usage.total_usage
    const sys = s.cpu_stats.system_cpu_usage
    const cpus = s.cpu_stats.online_cpus || 1
    const cpu = prev && sys > prev.sys ? ((cpuTotal - prev.cpuTotal) / (sys - prev.sys)) * cpus * 100 : null
    prev = { cpuTotal, sys }
    if (i % 5 === 0) last = await scrape()
    rows.push({
      t: (Date.now() - t0) / 1000,
      workingSet,
      usage: ms.usage,
      anon: ms.stats?.anon ?? null,
      file: ms.stats?.file ?? null,
      cpu,
      ...last,
    })
    const wait = tick + 1000 - Date.now()
    if (wait > 0) await sleep(wait)
  }

  mkdirSync(resultsDir, { recursive: true })
  const csv = [
    't_s,working_set_bytes,usage_bytes,anon_bytes,file_bytes,cpu_percent,rss_bytes,heap_bytes,external_bytes',
    ...rows.map((r) =>
      [r.t.toFixed(1), r.workingSet, r.usage, r.anon, r.file, r.cpu?.toFixed(3), r.rss, r.heap, r.external]
        .map((v) => v ?? '')
        .join(','),
    ),
  ].join('\n')
  writeFileSync(join(resultsDir, `${base}-${scenario}-${n}.csv`), csv + '\n')

  // Once, after sampling (an exec runs inside the container's cgroup, so not during it):
  // how much of the RSS is the process's own memory and how much is shared file pages
  // (the binary, node, the LiveKit .so), which the page cache shares between pods.
  const status = docker('exec', container, 'cat', '/proc/1/status')
  const kB = (field) => {
    const m = status.match(new RegExp(`^${field}:\\s+(\\d+) kB`, 'm'))
    return m ? Number(m[1]) * 1024 : null
  }

  // Live: read the counters, end the session, and time how long the worker takes to leave.
  let liveResult = {}
  if (scenario === 'live') {
    const counters = await scrape()
    const deleted = parseLines(live('run', '--rm', '--no-deps', 'tools', 'node', 'dispatch.ts', 'end')).find(
      (j) => j.msg === 'rooms deleted',
    )
    const ended = await waitForLog(container, 'ended', 30_000)
    const heard = await waitForLog('listener', 'stats', 30_000, (j) => j.final)
    liveResult = {
      jobToLiveMs,
      endToExitMs: deleted ? new Date(ended.time).getTime() - new Date(deleted.time).getTime() : null,
      audioInSec: counters.samplesIn == null ? null : counters.samplesIn / 16_000,
      audioOutSec: counters.samplesOut == null ? null : counters.samplesOut / 24_000,
      listener: { frames: heard.frames, audibleFrames: heard.audibleFrames, maxGapMs: heard.maxGapMs },
    }
    console.log(
      `[${key} #${n}] audio in ${liveResult.audioInSec?.toFixed(0)} s, out ${liveResult.audioOutSec?.toFixed(0)} s; listener heard ${(heard.audibleFrames / 100).toFixed(0)} s of sound; worker left ${liveResult.endToExitMs} ms after the rooms were deleted`,
    )
    live('rm', '-sf', 'host', 'listener')
  }

  const tail = rows.filter((r) => r.t >= (minutes - windowMin) * 60)
  const result = {
    run: n,
    readyMs,
    ...liveResult,
    workingSet: median(tail.map((r) => r.workingSet)),
    anon: median(tail.map((r) => r.anon)),
    file: median(tail.map((r) => r.file)),
    rssAnon: kB('RssAnon'),
    rssFile: kB('RssFile'),
    rss: median(tail.map((r) => r.rss)),
    heap: median(tail.map((r) => r.heap)),
    external: median(tail.map((r) => r.external)),
    peakWorkingSet: Math.max(...rows.map((r) => r.workingSet)),
    cpu: median(tail.map((r) => r.cpu)),
  }
  console.log(
    `[${key} #${n}] working set ${MiB(result.workingSet)} MiB, RSS ${MiB(result.rss)} MiB, heap ${MiB(result.heap)} MiB, CPU ${result.cpu?.toFixed(2)} %`,
  )
  docker(...compose, '--profile', runtime, 'rm', '-sf', service)
  return result
}

// The image's files as they sit on disk once unpacked (same on either Docker image store).
function unpackedImageSize() {
  const out = docker('run', '--rm', '--user', '0', '--entrypoint', 'du', image, '-sxb', '/')
  return Number(out.split(/\s+/)[0])
}

// Roughly what a registry pull transfers: the saved image, gzipped.
function gzippedImageSize() {
  return new Promise((resolve, reject) => {
    const save = spawn('docker', ['save', image])
    let bytes = 0
    save.stdout.pipe(createGzip()).on('data', (c) => (bytes += c.length)).on('end', () => resolve(bytes)).on('error', reject)
    save.on('error', reject)
  })
}

function writeSummary(all) {
  writeFileSync(join(resultsDir, 'summary.json'), JSON.stringify(all, null, 2) + '\n')
  const fmt = (b) => (b == null ? '–' : `${MiB(b)} MiB`)
  const isLive = (e) => e.scenario === 'live'
  const lines = [
    '# Worker memory measurements (generated by measure.mjs)',
    '',
    'Medians over the last minutes of each run. Working set = cgroup memory.current − inactive_file',
    '(what kubelet and `kubectl top` count). RssAnon / RssFile are read from /proc/1/status after sampling.',
    '',
    '## Idle',
    '',
    '| Runtime | Run | Ready after start | Working set | RSS | RssAnon | RssFile | Heap | Node external | Peak working set | CPU |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ]
  for (const rt of Object.keys(all).sort()) {
    const e = all[rt]
    if (!e || isLive(e)) continue
    for (const r of e.runs) {
      lines.push(
        `| ${rt} | ${r.run} | ${r.readyMs} ms | ${fmt(r.workingSet)} | ${fmt(r.rss)} | ${fmt(r.rssAnon)} | ${fmt(r.rssFile)} | ${fmt(r.heap)} | ${fmt(r.external)} | ${fmt(r.peakWorkingSet)} | ${r.cpu?.toFixed(2)} % |`,
      )
    }
    const m = (k) => median(e.runs.map((r) => r[k]))
    lines.push(
      `| **${rt}** | **median** | **${m('readyMs')} ms** | **${fmt(m('workingSet'))}** | **${fmt(m('rss'))}** | ${fmt(m('rssAnon'))} | ${fmt(m('rssFile'))} | ${fmt(m('heap'))} | ${fmt(m('external'))} | ${fmt(m('peakWorkingSet'))} | ${m('cpu')?.toFixed(2)} % |`,
    )
  }
  lines.push(
    '',
    '## One live track',
    '',
    'Audio in/out are the worker\'s own counters (seconds of host audio sent to Gemini, seconds of translation',
    'written to the out track). Heard = seconds of sound the listener received in the out room.',
    '',
    '| Runtime | Run | Job → live | Working set | RSS | RssAnon | RssFile | Heap | Node external | Peak working set | CPU | Audio in / out | Heard | Exit after end |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  )
  for (const rt of Object.keys(all).sort()) {
    const e = all[rt]
    if (!e || !isLive(e)) continue
    const row = (label, r, bold) => {
      const b = (x) => (bold ? `**${x}**` : x)
      return `| ${b(rt)} | ${b(label)} | ${r.jobToLiveMs} ms | ${b(fmt(r.workingSet))} | ${b(fmt(r.rss))} | ${fmt(r.rssAnon)} | ${fmt(r.rssFile)} | ${fmt(r.heap)} | ${fmt(r.external)} | ${fmt(r.peakWorkingSet)} | ${r.cpu?.toFixed(2)} % | ${r.audioInSec?.toFixed(0)} s / ${r.audioOutSec?.toFixed(0)} s | ${r.heard == null ? '–' : r.heard.toFixed(0) + ' s'} | ${r.endToExitMs} ms |`
    }
    for (const r of e.runs) lines.push(row(r.run, { ...r, heard: r.listener ? r.listener.audibleFrames / 100 : null }, false))
    const m = (k) => median(e.runs.map((r) => r[k]))
    lines.push(
      row(
        'median',
        {
          jobToLiveMs: m('jobToLiveMs'),
          workingSet: m('workingSet'),
          rss: m('rss'),
          rssAnon: m('rssAnon'),
          rssFile: m('rssFile'),
          heap: m('heap'),
          external: m('external'),
          peakWorkingSet: m('peakWorkingSet'),
          cpu: m('cpu'),
          audioInSec: m('audioInSec'),
          audioOutSec: m('audioOutSec'),
          heard: median(e.runs.map((r) => (r.listener ? r.listener.audibleFrames / 100 : null))),
          endToExitMs: m('endToExitMs'),
        },
        true,
      ),
    )
  }
  lines.push('', '## Images', '', '| Runtime | Image (unpacked files) | Image (docker save, gzipped) |', '|---|---|---|')
  for (const rt of ['go', 'node']) {
    const e = all[rt]
    if (e) lines.push(`| ${rt} | ${fmt(e.imageUnpackedBytes)} | ${fmt(e.imageGzipBytes)} |`)
  }
  lines.push('', '## Runs', '', '| Key | Scenario | GOMAXPROCS | Measured at | Length |', '|---|---|---|---|---|')
  for (const rt of Object.keys(all).sort()) {
    const e = all[rt]
    lines.push(
      `| ${rt} | ${e.scenario ?? 'idle'} | ${e.gomaxprocs ?? 'default'} | ${e.measuredAt} | ${e.runs.length} × ${e.minutes} min (median of last ${e.window} min) |`,
    )
  }
  writeFileSync(join(resultsDir, 'summary.md'), lines.join('\n') + '\n')
}

const results = []
for (let n = 1; n <= runs; n++) results.push(await oneRun(n))

const imageUnpackedBytes = unpackedImageSize()
const imageGzipBytes = await gzippedImageSize()
const summaryPath = join(resultsDir, 'summary.json')
const all = existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, 'utf8')) : {}
all[key] = { runtime, scenario, gomaxprocs: args.gomaxprocs || null, measuredAt: new Date().toISOString(), minutes, window: windowMin, imageUnpackedBytes, imageGzipBytes, runs: results }
writeSummary(all)
console.log(`image ${MiB(imageUnpackedBytes)} MiB unpacked, ${MiB(imageGzipBytes)} MiB gzipped; wrote ${join(resultsDir, 'summary.md')}`)
