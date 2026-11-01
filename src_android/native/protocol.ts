import { md5 } from 'js-md5'
import type { Telemetry } from '../../src/web/model.ts'

export const SERVICE = 'e659f300-ea98-11e3-ac10-0800200c9a66'
export const AUTH_READ = 'e659f3fe-ea98-11e3-ac10-0800200c9a66'
export const AUTH_WRITE = 'e659f3ff-ea98-11e3-ac10-0800200c9a66'
export const CELL_MAX_AGE = 30000
const SALT = Uint8Array.of(0xd9, 0x25, 0x5f, 0x0f, 0x23, 0x35, 0x4e, 0x19, 0xba, 0x73, 0x9c, 0xcd, 0xc4, 0xa9, 0x17, 0x65)
const FIELDS = {
  mode: '302', battery: '303', trip: '30a', rpm: '30b', temperature: '310',
  firmware: '311', current: '312', batteryTemperature: '315', voltage: '316',
  hardware: '318', lifetime: '319', cell: '31b',
} as const
const MODES: Record<number, string> = { 4: 'Sequoia', 5: 'Cruz', 6: 'Mission', 7: 'Elevated', 8: 'Delirium', 9: 'Custom' }
type FieldName = keyof typeof FIELDS
export type Permission = 'read' | 'write' | 'notify'
export interface BleIo {
  has(uuid: string, permission: Permission): boolean
  read(uuid: string): Promise<Uint8Array>
  write(uuid: string, data: Uint8Array): Promise<void>
  subscribe(uuid: string, receive: (data: Uint8Array) => void): Promise<void>
  unsubscribe(uuid: string): Promise<void>
}
export interface Identity { hardware: number; firmware: number }

export function fieldUuid(name: FieldName) { return `e659f${FIELDS[name]}-ea98-11e3-ac10-0800200c9a66` }
export function word(data: Uint8Array, signed = false): number {
  if (data.length !== 2) throw new Error(`Expected two bytes; received ${data.length}.`)
  const value = data[0] * 256 + data[1]
  return signed && value >= 32768 ? value - 65536 : value
}
export function geminiResponse(challenge: Uint8Array): Uint8Array {
  if (challenge.length !== 20) throw new Error('A Gemini challenge must contain exactly 20 bytes.')
  const input = new Uint8Array(32)
  input.set(challenge.subarray(3, 19))
  input.set(SALT, 16)
  const response = new Uint8Array(20)
  response.set(challenge.subarray(0, 3))
  response.set(new Uint8Array(md5.arrayBuffer(input)), 3)
  response[19] = response.subarray(0, 19).reduce((checksum, byte) => checksum ^ byte, 0)
  return response
}
export function assertActive(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason
}
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  assertActive(signal)
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}
export function validateIdentity({ hardware, firmware }: Identity) {
  if (!Number.isInteger(hardware) || !Number.isInteger(firmware) ||
    hardware < 4000 || hardware > 4209 || firmware <= 4000 || firmware >= 4141
  ) throw new Error(`Unsupported local handshake: hardware ${hardware}, firmware ${firmware}. Only legacy XR 4000-4209 / 4001-4140 is supported. No authentication commands were sent.`)
}
export function decodeCell(data: Uint8Array, firmware: number): { index: number; voltage: number } | null {
  const encoded = word(data)
  const index = firmware >= 4141 ? encoded >> 12 : data[0]
  const voltage = firmware >= 4141 ? (encoded & 0x0fff) * .0011 : data[1] * .02
  if (index === 15) return null
  if (index < 0 || index >= 15 || voltage <= 0 || voltage > 5) throw new Error('Invalid XR cell index or voltage.')
  return { index, voltage }
}
export class CellSamples {
  private samples = new Map<number, { voltage: number; timestamp: number }>()
  update(data: Uint8Array, firmware: number, now: number) {
    const cell = decodeCell(data, firmware)
    if (cell) this.samples.set(cell.index, { voltage: cell.voltage, timestamp: now })
  }
  values(now: number): (number | null)[] {
    return Array.from({ length: 15 }, (_, index) => {
      const sample = this.samples.get(index)
      return sample && now - sample.timestamp <= CELL_MAX_AGE ? Number(sample.voltage.toFixed(4)) : null
    })
  }
}
export async function readIdentity(io: BleIo): Promise<Identity> {
  for (const field of ['hardware', 'firmware'] as const) {
    if (!io.has(fieldUuid(field), 'read')) throw new Error(`Missing board identity characteristic: ${field}.`)
  }
  return { hardware: word(await io.read(fieldUuid('hardware'))), firmware: word(await io.read(fieldUuid('firmware'))) }
}

export class Session {
  private io: BleIo
  private identity: Identity
  private signal: AbortSignal
  private cells = new CellSamples()
  private warnings = new Set<string>()

  constructor(io: BleIo, identity: Identity, signal: AbortSignal) {
    validateIdentity(identity)
    this.io = io
    this.identity = identity
    this.signal = signal
  }
  private warnOnce(field: string, message: string) {
    if (!this.warnings.has(field)) { this.warnings.add(field); console.warn(message) }
  }
  private async read(name: FieldName, optional = false): Promise<Uint8Array | null> {
    assertActive(this.signal)
    const uuid = fieldUuid(name)
    if (!this.io.has(uuid, 'read')) {
      if (!optional) throw new Error(`Missing readable telemetry characteristic: ${name}.`)
      this.warnOnce(name, `Board does not expose optional telemetry: ${name}.`)
      return null
    }
    const value = await this.io.read(uuid)
    assertActive(this.signal)
    word(value)
    return value
  }
  private async number(name: FieldName, signed = false): Promise<number> {
    const value = await this.read(name)
    if (value === null) throw new Error(`Missing required telemetry: ${name}.`)
    return word(value, signed)
  }
  private async touch() {
    assertActive(this.signal)
    const uuid = fieldUuid('firmware')
    if (!this.io.has(uuid, 'write')) throw new Error('The legacy session command is unavailable.')
    await this.io.write(uuid, Uint8Array.of(this.identity.firmware >> 8, this.identity.firmware & 255))
  }
  async authenticate() {
    const originalMode = await this.number('mode')
    if (originalMode === 0) {
      if (!this.io.has(AUTH_READ, 'notify') || !this.io.has(AUTH_WRITE, 'write')) throw new Error('Legacy authentication characteristics are missing.')
      const incoming: number[] = []
      let malformed = false
      await this.io.subscribe(AUTH_READ, (data) => {
        if (incoming.length === 20 || malformed) return
        incoming.push(...data)
        if (data.length === 0 || incoming.length > 20) malformed = true
      })
      let response: Uint8Array
      try {
        await this.touch()
        const deadline = performance.now() + 10000
        while (incoming.length !== 20 && !malformed && performance.now() < deadline) await pause(10, this.signal)
        assertActive(this.signal)
        if (malformed) throw new Error('Invalid Gemini challenge length.')
        if (incoming.length !== 20) throw new Error('Timed out waiting for the Gemini challenge.')
        response = geminiResponse(Uint8Array.from(incoming))
      } finally { await this.io.unsubscribe(AUTH_READ) }
      assertActive(this.signal)
      await this.io.write(AUTH_WRITE, response)
    } else await this.touch()
    const deadline = performance.now() + 5000
    let mode = 0
    let unlocked = false
    while (performance.now() < deadline) {
      mode = await this.number('mode')
      const voltage = mode === 0 ? 0 : await this.number('voltage') * .1
      if (mode !== 0 && voltage > 0 && voltage <= 80) { unlocked = true; break }
      await pause(100, this.signal)
    }
    if (!unlocked) throw new Error('Authentication did not unlock valid telemetry; zeros are not measurements.')
    if (originalMode !== 0 && mode !== originalMode) throw new Error('Riding mode changed unexpectedly during authentication.')
    const after = await readIdentity(this.io)
    if (after.hardware !== this.identity.hardware || after.firmware !== this.identity.firmware) throw new Error('Board identity changed during authentication.')
  }
  async snapshot(): Promise<Telemetry & Identity> {
    const mode = await this.number('mode')
    if (mode === 0) throw new Error('Telemetry is locked. Zero values are not measurements.')
    const batteryPercent = await this.number('battery')
    const trip = await this.number('trip')
    const rpm = await this.number('rpm', true)
    const current = await this.number('current', true)
    const voltage = await this.number('voltage') * .1
    const lifetime = await this.number('lifetime')
    if (voltage <= 0 || voltage > 80 || batteryPercent > 100) throw new Error('Invalid battery telemetry; the last valid sample is retained.')
    const temperature = await this.read('temperature', true)
    const batteryTemperature = await this.read('batteryTemperature', true)
    const motorTemperature = temperature && temperature[1] !== 0 ? temperature[1] : null
    if (temperature?.[1] === 0) this.warnOnce('motor', 'Legacy XR reports zero motor temperature; treating it as unavailable.')
    return {
      ...this.identity, source: 'physical', timestamp: Date.now(), batteryPercent,
      packVoltage: Number(voltage.toFixed(2)), current: Number((current * .002).toFixed(3)),
      speed: Number((Math.abs(rpm) * .91766 * 60 / 1000).toFixed(3)),
      tripKm: Number((trip * .91766 / 1000).toFixed(4)), lifetimeKm: Number((lifetime * 1.609344).toFixed(3)),
      mode: MODES[mode] ?? `Unknown (${mode})`, cellVoltages: this.cells.values(performance.now()),
      controllerTemperature: temperature === null ? null : temperature[0], motorTemperature,
      batteryTemperature: batteryTemperature === null ? null : batteryTemperature[1],
    }
  }
  async stream(emit: (data: Telemetry & Identity) => void, abort: AbortController) {
    const pollCells = async () => {
      while (true) {
        const data = await this.read('cell')
        if (data === null) throw new Error('Cell telemetry is unavailable.')
        this.cells.update(data, this.identity.firmware, performance.now())
        await pause(100, this.signal)
      }
    }
    const pollFrames = async () => {
      while (true) { emit(await this.snapshot()); await pause(300, this.signal) }
    }
    const keepalive = async () => {
      while (true) { await pause(10000, this.signal); await this.touch() }
    }
    const workers = [pollCells(), pollFrames(), keepalive()]
    try { await Promise.all(workers) }
    finally { abort.abort(); await Promise.allSettled(workers) }
  }
}
