// Benchmark for ADR-0001, option 1: the WebSocket fan-out. Opens N fake listeners on a live
// session and reports the bandwidth each one receives and the gaps between audio chunks.
//
//   npx tsx scripts/bench-fanout-ws.ts <joinCode> <lang> <listeners> [seconds]
import WebSocket from 'ws'

const [code, lang, countArg, secondsArg = '30'] = process.argv.slice(2)
if (!code || !lang || !countArg) {
  console.error('usage: tsx scripts/bench-fanout-ws.ts <joinCode> <lang> <listeners> [seconds]')
  process.exit(2)
}
const count = Number(countArg)
const seconds = Number(secondsArg)
const url = `ws://localhost:8080/api/ws/listen/${code}?lang=${lang}`

interface Listener {
  bytes: number
  gaps: number[]
  last: number
  closed: boolean
}
const listeners: Listener[] = []
let measuring = false

function connect(): void {
  const l: Listener = { bytes: 0, gaps: [], last: 0, closed: false }
  listeners.push(l)
  const ws = new WebSocket(url)
  ws.on('message', (data, isBinary) => {
    if (!isBinary || !measuring) return // captions are JSON text; only count audio
    const now = performance.now()
    if (l.last) l.gaps.push(now - l.last)
    l.last = now
    l.bytes += (data as Buffer).length
  })
  ws.on('error', (err: NodeJS.ErrnoException) => console.warn(`a listener could not connect: ${err.code ?? err.message}`))
  ws.on('close', (closeCode) => {
    l.closed = true
    console.warn(`a listener closed (code ${closeCode})`)
  })
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// The backend allows 60 listener connections per minute per IP, so join one per second.
for (let i = 0; i < count; i++) {
  connect()
  await sleep(1000)
}
console.log(`${listeners.filter((l) => !l.closed).length} of ${count} listeners connected; measuring for ${seconds} s...`)
measuring = true
await sleep(seconds * 1000)
measuring = false

const percentile = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) * p)] ?? NaN
const kbps = listeners.map((l) => (l.bytes * 8) / 1000 / seconds)
const gaps = listeners.flatMap((l) => l.gaps)
const avg = kbps.reduce((a, b) => a + b, 0) / kbps.length

console.log(`bandwidth per listener (kbit/s): min ${Math.min(...kbps).toFixed(0)}, avg ${avg.toFixed(0)}, max ${Math.max(...kbps).toFixed(0)}  (raw PCM theory: 384)`)
console.log(`gap between audio chunks (ms): median ${percentile(gaps, 0.5).toFixed(0)}, p99 ${percentile(gaps, 0.99).toFixed(0)}, max ${percentile(gaps, 1).toFixed(0)}`)
console.log(`listeners closed: ${listeners.filter((l) => l.closed).length} of ${count}`)
process.exit(0)
