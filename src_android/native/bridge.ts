import { App } from '@capacitor/app'
import type { PluginListenerHandle } from '@capacitor/core'
import { BleClient, ScanMode } from '@capacitor-community/bluetooth-le'
import type { BleService } from '@capacitor-community/bluetooth-le'
import type { Availability, Connection, SampleEvent, Transport } from '../../src/web/bridge'
import type { DiscoveredBoard } from '../../src/web/model'
import { AUTH_WRITE, SERVICE, Session, assertActive, fieldUuid, pause, readIdentity } from './protocol'
import type { BleIo, Permission } from './protocol'

function message(error: unknown) { return error instanceof Error ? error.message : String(error) }
function cancelled(error: unknown) { return error instanceof Error && error.name === 'AbortError' }

class NativeIo implements BleIo {
  private device: string
  private services: BleService[]
  private signal: AbortSignal
  private tail: Promise<void> = Promise.resolve()
  constructor(device: string, services: BleService[], signal: AbortSignal) {
    this.device = device
    this.services = services
    this.signal = signal
  }
  has(uuid: string, permission: Permission) {
    return this.services.find((service) => service.uuid.toLowerCase() === SERVICE)?.characteristics
      .some((characteristic) => characteristic.uuid.toLowerCase() === uuid && characteristic.properties[permission]) ?? false
  }
  private enqueue<T>(operation: () => Promise<T>, cleanup = false): Promise<T> {
    const request = this.tail.then(() => { if (!cleanup) assertActive(this.signal); return operation() })
    // Only the queue tail consumes failures; the request still rejects to its caller.
    this.tail = request.then(() => undefined, () => undefined)
    return request
  }
  read(uuid: string) {
    return this.enqueue(async () => {
      const data = await BleClient.read(this.device, SERVICE, uuid, { timeout: 5000 })
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
    })
  }
  write(uuid: string, bytes: Uint8Array) {
    if (uuid !== fieldUuid('firmware') && uuid !== AUTH_WRITE) throw new Error('Board configuration writes are prohibited.')
    return this.enqueue(() => BleClient.write(this.device, SERVICE, uuid, new DataView(new Uint8Array(bytes).buffer), { timeout: 5000 }))
  }
  subscribe(uuid: string, receive: (data: Uint8Array) => void) {
    return this.enqueue(() => BleClient.startNotifications(this.device, SERVICE, uuid, (data) => {
      receive(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
    }, { timeout: 5000 }))
  }
  unsubscribe(uuid: string) {
    return this.enqueue(() => BleClient.stopNotifications(this.device, SERVICE, uuid), true)
  }
}

export class AndroidBridge implements Transport {
  private onEvent: (event: Connection | SampleEvent) => void
  private onAvailability: (availability: Availability) => void
  private onError: (message: string) => void
  private onForeground: (visible: boolean) => void
  private known = new Map<string, { board: DiscoveredBoard; seen: number }>()
  private task: Promise<void> | null = null
  private abort: AbortController | null = null
  private scanAbort: AbortController | null = null
  private initialization: Promise<void> | null = null
  private listener: PluginListenerHandle | null = null
  private enabledNotifications = false
  private closed = false
  private foreground = true
  private state: Connection = { type: 'state', status: 'offline', boardId: null, boardName: null, error: null }

  constructor(
    onEvent: (event: Connection | SampleEvent) => void,
    onAvailability: (availability: Availability) => void,
    onError: (message: string) => void,
    onForeground: (visible: boolean) => void,
  ) {
    this.onEvent = onEvent
    this.onAvailability = onAvailability
    this.onError = onError
    this.onForeground = onForeground
  }
  private report(error: unknown) {
    console.error('WheelSoul Android BLE:', error)
    if (!this.closed) this.onError(message(error))
  }
  private emit(state: Connection) {
    this.state = state
    if (!this.closed) this.onEvent(state)
  }
  private offline() { this.emit({ type: 'state', status: 'offline', boardId: null, boardName: null, error: null }) }
  async start() {
    try {
      const state = await App.getState()
      if (this.closed) return
      this.foreground = state.isActive
      this.onForeground(state.isActive)
      const listener = await App.addListener('appStateChange', ({ isActive }) => {
        if (this.closed) return
        this.foreground = isActive
        this.onForeground(isActive)
        if (!isActive) {
          this.scanAbort?.abort(new DOMException('Bluetooth scan stopped because the app left the foreground.', 'AbortError'))
          if (this.task) {
            this.onError('This first Android version disconnects in the background. Last valid readings remain saved.')
            void this.disconnect().catch((error) => this.report(error))
          }
        }
      })
      if (this.closed) { await listener.remove(); return }
      this.listener = listener
      this.offline()
      this.onAvailability({ ready: true, enabled: true, error: null })
    } catch (error) {
      this.report(error)
      if (!this.closed) this.onAvailability({ ready: false, enabled: false, error: message(error) })
    }
  }
  private async initialize() {
    if (this.closed || !this.foreground) throw new Error('Open WheelSoul in the foreground before using Bluetooth.')
    if (!this.initialization) {
      this.initialization = BleClient.initialize({ androidNeverForLocation: true })
      try { await this.initialization }
      catch (error) { this.initialization = null; throw error }
    } else await this.initialization
    if (this.closed || !this.foreground) throw new Error('Bluetooth initialization was interrupted.')
    if (!this.enabledNotifications) {
      await BleClient.startEnabledNotifications((enabled) => {
        if (this.closed) return
        this.onAvailability({ ready: true, enabled, error: enabled ? null : 'Turn on Bluetooth on this phone.' })
        if (!enabled) this.abort?.abort(new Error('Bluetooth was switched off.'))
      })
      if (this.closed) {
        await BleClient.stopEnabledNotifications()
        throw new DOMException('Dashboard closed.', 'AbortError')
      }
      this.enabledNotifications = true
    }
    if (!await BleClient.isEnabled()) {
      this.onAvailability({ ready: true, enabled: false, error: 'Turn on Bluetooth on this phone.' })
      throw new Error('Turn on Bluetooth on this phone before scanning.')
    }
    if (this.closed || !this.foreground) throw new Error('Bluetooth initialization was interrupted.')
  }
  async scan(): Promise<DiscoveredBoard[]> {
    if (this.scanAbort) throw new Error('A Bluetooth scan is already running.')
    await this.initialize()
    const abort = new AbortController()
    this.scanAbort = abort
    const boards = new Map<string, DiscoveredBoard>()
    try {
      await BleClient.requestLEScan({ services: [SERVICE], scanMode: ScanMode.SCAN_MODE_LOW_LATENCY }, (result) => {
        if (abort.signal.aborted || this.closed) return
        if (!result.device.deviceId || typeof result.rssi !== 'number' || !Number.isFinite(result.rssi)) {
          console.warn('Ignoring incomplete Android BLE advertisement without a device identifier or RSSI.')
          return
        }
        const board = {
          id: result.device.deviceId, advertisedName: result.localName || result.device.name || 'Onewheel', rssi: result.rssi,
        }
        boards.set(board.id, board)
        this.known.set(board.id, { board, seen: performance.now() })
      })
      await pause(8000, abort.signal)
      return [...boards.values()]
    } finally {
      try { await BleClient.stopLEScan() }
      finally { this.scanAbort = null }
    }
  }
  async connect(id: string) {
    if (this.task) throw new Error('A board is already connecting or connected. Disconnect it first.')
    const found = this.known.get(id)
    if (!found || performance.now() - found.seen > 300000) throw new Error('Choose a board from a recent Bluetooth scan.')
    await this.initialize()
    if (this.task) throw new Error('Another connection has started. Disconnect it first.')
    const abort = new AbortController()
    this.abort = abort
    this.emit({ type: 'state', status: 'connecting', boardId: id, boardName: found.board.advertisedName, error: null })
    this.task = this.run(id, found.board.advertisedName, abort)
  }
  private async run(id: string, name: string, abort: AbortController) {
    try {
      await BleClient.connect(id, () => {
        if (!abort.signal.aborted) abort.abort(new Error('BLE connection lost. Last valid readings are retained.'))
      }, { timeout: 20000 })
      assertActive(abort.signal)
      const io = new NativeIo(id, await BleClient.getServices(id), abort.signal)
      const session = new Session(io, await readIdentity(io), abort.signal)
      await session.authenticate()
      assertActive(abort.signal)
      this.emit({ type: 'state', status: 'connected', boardId: id, boardName: name, error: null })
      await session.stream((data) => {
        if (!this.closed && !abort.signal.aborted) this.onEvent({ type: 'telemetry', boardId: id, data })
      }, abort)
    } catch (error) {
      if (!cancelled(error)) {
        this.report(error)
        this.emit({ type: 'state', status: 'error', boardId: id, boardName: name, error: message(error) })
      }
    } finally {
      abort.abort()
      try { await BleClient.disconnect(id) }
      catch (error) {
        this.report(error)
        this.emit({ type: 'state', status: 'error', boardId: id, boardName: name, error: message(error) })
      }
      this.abort = null
      this.task = null
      if (this.state.status !== 'error') this.offline()
    }
  }
  async disconnect() {
    this.abort?.abort(new DOMException('Disconnected by the user.', 'AbortError'))
    if (this.task) await this.task
    this.offline()
  }
  stop() {
    this.closed = true
    this.scanAbort?.abort(new DOMException('Dashboard closed.', 'AbortError'))
    void this.disconnect().catch((error) => this.report(error))
    if (this.listener) void this.listener.remove().catch((error) => this.report(error))
    if (this.enabledNotifications) void BleClient.stopEnabledNotifications().catch((error) => this.report(error))
  }
}
