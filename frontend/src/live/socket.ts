/** ws(s)://<this host>/api<path>. nginx proxies /api (including WebSocket upgrades) to the backend. */
export function wsUrl(path: string): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${window.location.host}/api${path}`
}

/** Exponential backoff with jitter, capped at 8 s. */
export function backoffMs(attempt: number): number {
  return Math.min(8000, 500 * 2 ** attempt) * (0.75 + Math.random() * 0.5)
}

export interface RetrySocketOptions {
  url: () => string
  /** Close codes after which retrying is pointless (the server said the session is over or we aren't allowed). */
  fatalCodes: number[]
  onOpen: () => void
  onMessage: (data: string | ArrayBuffer) => void
  /** The connection closed. `fatal` means it will not be retried. */
  onDown: (info: { code: number; fatal: boolean }) => void
}

export interface RetrySocket {
  readonly socket: WebSocket | null
  send(data: ArrayBuffer | string): boolean
  close(): void
}

/** A WebSocket that reconnects on its own until told to stop or the server closes it for good. */
export function openRetrySocket(opts: RetrySocketOptions): RetrySocket {
  let ws: WebSocket | null = null
  let attempt = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  const open = () => {
    if (stopped) return
    const socket = new WebSocket(opts.url())
    socket.binaryType = 'arraybuffer'
    ws = socket
    socket.onopen = () => {
      attempt = 0
      opts.onOpen()
    }
    socket.onmessage = (e) => opts.onMessage(e.data as string | ArrayBuffer)
    socket.onclose = (e) => {
      if (ws !== socket) return
      ws = null
      if (stopped) return
      const fatal = opts.fatalCodes.includes(e.code)
      opts.onDown({ code: e.code, fatal })
      if (!fatal) timer = setTimeout(open, backoffMs(attempt++))
    }
  }
  open()

  return {
    get socket() {
      return ws
    },
    send(data) {
      if (ws?.readyState !== WebSocket.OPEN) return false
      ws.send(data)
      return true
    },
    close() {
      stopped = true
      clearTimeout(timer)
      const s = ws
      ws = null
      s?.close(1000)
    },
  }
}
