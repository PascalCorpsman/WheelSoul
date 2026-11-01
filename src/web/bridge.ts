import { isTelemetry, record } from './model.ts'
import type { DiscoveredBoard, Telemetry } from './model.ts'

export interface Connection {
  type: 'state'
  status: 'offline' | 'connecting' | 'connected' | 'error'
  boardId: string | null
  boardName: string | null
  error: string | null
}
export interface SampleEvent { type: 'telemetry'; boardId: string; data: Telemetry }
export interface Availability { ready: boolean; enabled: boolean; error: string | null }
export interface Transport {
  start(): Promise<void>
  scan(): Promise<DiscoveredBoard[]>
  connect(id: string): Promise<void>
  disconnect(): Promise<void>
  stop(): void
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

export function parseEvent(value: unknown): Connection | SampleEvent {
  if (!record(value)) throw new Error('Invalid server event.')
  if (value.type === 'state' &&
    ['offline', 'connecting', 'connected', 'error'].includes(String(value.status)) &&
    nullableString(value.boardId) && nullableString(value.boardName) && nullableString(value.error)
  ) {
    const status = value.status
    if (status !== 'offline' && status !== 'connecting' && status !== 'connected' && status !== 'error') throw new Error('Invalid connection status.')
    if ((status === 'connecting' || status === 'connected') &&
      (!value.boardId || !value.boardName?.trim())
    ) throw new Error('Connected state is missing its board identity.')
    if (status === 'error' && !value.error?.trim()) throw new Error('Error state is missing its explanation.')
    return { type: 'state', status, boardId: value.boardId, boardName: value.boardName, error: value.error }
  }
  if (value.type === 'telemetry' && typeof value.boardId === 'string' && value.boardId.length > 0 &&
    isTelemetry(value.data) && value.data.source === 'physical'
  ) return { type: 'telemetry', boardId: value.boardId, data: value.data }
  throw new Error('Invalid telemetry event; cached measurements have not been replaced.')
}

export function parseDiscovered(value: unknown): DiscoveredBoard[] {
  if (!record(value) || !Array.isArray(value.boards)) throw new Error('Invalid BLE scan response.')
  return value.boards.map((b: unknown) => {
    if (!record(b) || typeof b.id !== 'string' || !b.id || typeof b.advertisedName !== 'string' ||
      !b.advertisedName.trim() || typeof b.rssi !== 'number' || !Number.isFinite(b.rssi)
    ) throw new Error('Invalid discovered board.')
    return { id: b.id, advertisedName: b.advertisedName, rssi: b.rssi }
  })
}

export const OFFLINE: Connection = { type: 'state', status: 'offline', boardId: null, boardName: null, error: null }

export class Bridge {
  private token: string | null = null
  private socket: WebSocket | null = null
  private closed = false
  private retry: ReturnType<typeof setTimeout> | null = null
  private abort = new AbortController()
  private onEvent: (event: Connection | SampleEvent) => void
  private onAvailability: (info: Availability) => void
  private onError: (message: string) => void

  constructor(
    onEvent: (event: Connection | SampleEvent) => void,
    onAvailability: (info: Availability) => void,
    onError: (message: string) => void,
  ) {
    this.onEvent = onEvent
    this.onAvailability = onAvailability
    this.onError = onError
  }

  async start() {
    try {
      const info = await this.request('/api/session', 'GET')
      if (this.closed) return
      if (!record(info) || typeof info.token !== 'string' || typeof info.liveBleEnabled !== 'boolean' || info.apiVersion !== 1) {
        throw new Error('Unsupported local server. Start the WheelSoul Python server.')
      }
      this.token = info.token
      const enabled = info.liveBleEnabled
      const url = new URL('/api/events', location.href)
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      url.searchParams.set('token', this.token)
      const socket = new WebSocket(url)
      this.socket = socket
      socket.onopen = () => this.onAvailability({ ready: true, enabled, error: null })
      socket.onmessage = (message) => {
        try {
          const value: unknown = JSON.parse(message.data)
          this.onEvent(parseEvent(value))
        } catch (error) {
          this.onError(error instanceof Error ? error.message : String(error))
          socket.close()
        }
      }
      socket.onclose = () => {
        if (this.closed) return
        this.onEvent(OFFLINE)
        this.onAvailability({ ready: false, enabled: false, error: 'Local server connection closed. Last valid measurements are retained.' })
        this.retry = setTimeout(() => { void this.start() }, 2000)
      }
      socket.onerror = () => this.onError('Local event connection failed. Check the server terminal.')
    } catch (error) {
      if (this.closed) return
      this.onAvailability({
        ready: false, enabled: false,
        error: error instanceof Error ? error.message : String(error),
      })
      this.retry = setTimeout(() => { void this.start() }, 5000)
    }
  }

  private async request(path: string, method: 'GET' | 'POST' = 'POST', body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {}
    if (this.token) headers['X-WheelSoul-Token'] = this.token
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const options: RequestInit = { method, headers, signal: this.abort.signal }
    if (body !== undefined) {
      if (method === 'GET') throw new Error('GET requests cannot contain a command body.')
      options.body = JSON.stringify(body)
    }
    const response = await fetch(path, options)
    if (!response.headers.get('Content-Type')?.includes('application/json')) {
      throw new Error('Live server is unavailable. Run npm run build and the Python server; Vite alone only previews the demo.')
    }
    const value: unknown = await response.json()
    if (!response.ok) throw new Error(record(value) && typeof value.error === 'string' ? value.error : `Local server error (${response.status}).`)
    return value
  }

  async scan(): Promise<DiscoveredBoard[]> {
    if (!this.token) throw new Error('The local BLE server is not ready.')
    return parseDiscovered(await this.request('/api/scan'))
  }

  async connect(id: string) {
    if (!this.token) throw new Error('The local BLE server is not ready.')
    const response = await this.request('/api/connect', 'POST', { id })
    if (!record(response) || response.accepted !== true) throw new Error('The server did not accept the connection request.')
  }

  async disconnect() {
    if (!this.token) throw new Error('The local BLE server is not ready.')
    const response = await this.request('/api/disconnect')
    if (!record(response) || response.disconnected !== true) throw new Error('The server did not confirm disconnection.')
  }

  stop() {
    this.closed = true
    this.abort.abort()
    if (this.retry !== null) clearTimeout(this.retry)
    this.socket?.close()
  }
}
