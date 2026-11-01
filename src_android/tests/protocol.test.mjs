import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AUTH_READ, AUTH_WRITE, CELL_MAX_AGE, EXTRA_FIELDS, CellSamples, Session, decodeCell,
  fieldUuid, geminiResponse, pause, readIdentity, validateIdentity, word,
} from '../native/protocol.ts'
import { isTelemetry } from '../../src/web/model.ts'

const challenge = Uint8Array.from(Buffer.from('435258000102030405060708090a0b0c0d0e0f00', 'hex'))
const response = '435258c15a4c9f0616f53b5bdde730fc15280847'
const identity = { hardware: 4206, firmware: 4134 }
function fakeIo(locked = true) {
  const values = { mode: 8, hardware: 4206, firmware: 4134, battery: 43, trip: 1000, rpm: -100, current: -27, voltage: 567, lifetime: 2660 }
  Object.assign(values, Object.fromEntries(Object.keys(EXTRA_FIELDS).map((name) => [name, 0])), {
    pitch: 1800, roll: 1750, yaw: 1900, tripAmpHours: 1000, regenAmpHours: 500,
    boardSerial: 1001, batterySerial: 2001, statusFlagsRaw: 65535, unknown1Raw: 1234,
  })
  let receive, cellIndex = 0
  return {
    values, locked, writes: [], stopped: false,
    has: () => true,
    async read(uuid) {
      const name = Object.keys(values).find((key) => fieldUuid(key) === uuid)
      if (name) {
        const value = name === 'mode' && this.locked ? 0 : values[name]
        return Uint8Array.of((value >> 8) & 255, value & 255)
      }
      if (uuid === fieldUuid('temperature')) return Uint8Array.of(19, 21)
      if (uuid === fieldUuid('batteryTemperature')) return Uint8Array.of(0, 18)
      if (uuid === fieldUuid('cell')) return Uint8Array.of(cellIndex++ % 15, 190)
      throw new Error(`Unexpected read: ${uuid}`)
    },
    async write(uuid, data) {
      this.writes.push({ uuid, data: Buffer.from(data).toString('hex') })
      if (uuid === fieldUuid('firmware')) {
        assert.equal(Buffer.from(data).toString('hex'), '1026')
        if (receive) {
          receive(challenge.subarray(0, 4))
          receive(challenge.subarray(4, 11))
          receive(challenge.subarray(11))
        }
      } else if (uuid === AUTH_WRITE) {
        assert.equal(Buffer.from(data).toString('hex'), response)
        this.locked = false
      } else throw new Error('Configuration writes are prohibited.')
    },
    async subscribe(uuid, callback) { assert.equal(uuid, AUTH_READ); receive = callback },
    async unsubscribe(uuid) { assert.equal(uuid, AUTH_READ); this.stopped = true; receive = undefined },
  }
}

test('Android authentication matches the verified Python Gemini vector', () => {
  assert.equal(Buffer.from(geminiResponse(challenge)).toString('hex'), response)
  assert.throws(() => geminiResponse(challenge.subarray(1)))
  assert.equal(word(Uint8Array.of(0x10, 0x26)), 4134)
  assert.equal(word(Uint8Array.of(0xff, 0xe5), true), -27)
  assert.throws(() => word(Uint8Array.of(0)))
})
test('unsupported hardware and firmware are rejected without writes', () => {
  for (const value of [
    { hardware: 4210, firmware: 4134 }, { hardware: 4206, firmware: 4155 },
    { hardware: 3000, firmware: 4134 }, { hardware: 4206, firmware: 4000 },
    { hardware: NaN, firmware: 4134 },
  ]) assert.throws(() => validateIdentity(value))
})
test('cells use the same 20 mV conversion and exact freshness threshold', () => {
  const cells = new CellSamples()
  for (let i = 0; i < 15; i++) cells.update(Uint8Array.of(i, 190), 4134, 100)
  assert.deepEqual(cells.values(100 + CELL_MAX_AGE), Array(15).fill(3.8))
  assert.deepEqual(cells.values(101 + CELL_MAX_AGE), Array(15).fill(null))
  assert.equal(decodeCell(Uint8Array.of(15, 0), 4134), null)
  assert.throws(() => decodeCell(Uint8Array.of(0, 0), 4134))
  assert.deepEqual(decodeCell(Uint8Array.of(0x1d, 0x7e), 4141), { index: 1, voltage: 3454 * .0011 })
})
test('Android inventory covers all 32 readable vendor characteristics without auth endpoints', () => {
  const core = ['mode', 'battery', 'trip', 'rpm', 'temperature', 'firmware', 'current', 'batteryTemperature', 'voltage', 'hardware', 'lifetime', 'cell']
  const identifiers = [...core, ...Object.keys(EXTRA_FIELDS)].map((name) => fieldUuid(name).split('-')[0])
  assert.deepEqual(new Set(identifiers), new Set(Array.from({ length: 32 }, (_, i) => `e659f${(0x301 + i).toString(16)}`)))
})
test('cold authentication handles fragments and only writes allowed endpoints', async () => {
  const io = fakeIo()
  assert.deepEqual(await readIdentity(io), identity)
  await new Session(io, identity, new AbortController().signal).authenticate()
  assert.deepEqual(io.writes, [{ uuid: fieldUuid('firmware'), data: '1026' }, { uuid: AUTH_WRITE, data: response }])
  assert.equal(io.stopped, true)
  assert.equal(io.locked, false)
  assert.equal(io.values.mode, 8)
})
test('already unlocked boards only receive the unchanged session value', async () => {
  const io = fakeIo(false)
  await new Session(io, identity, new AbortController().signal).authenticate()
  assert.deepEqual(io.writes, [{ uuid: fieldUuid('firmware'), data: '1026' }])
})
test('malformed challenges stop notifications without responding', async () => {
  const io = fakeIo()
  io.subscribe = async (_uuid, callback) => { callback(new Uint8Array(21)) }
  await assert.rejects(new Session(io, identity, new AbortController().signal).authenticate(), /challenge length/)
  assert.equal(io.stopped, true)
  assert.equal(io.writes.some((write) => write.uuid === AUTH_WRITE), false)
})
test('identity changes abort authentication', async () => {
  const io = fakeIo()
  io.values.hardware = 4205
  await assert.rejects(new Session(io, identity, new AbortController().signal).authenticate(), /identity changed/)
})
test('Android frames preserve units, signs, temperatures and missing cell groups', async () => {
  const data = await new Session(fakeIo(false), identity, new AbortController().signal).snapshot()
  assert.equal(data.source, 'physical')
  assert.equal(data.packVoltage, 56.7)
  assert.equal(data.current, -.054)
  assert.equal(data.speed, 5.506)
  assert.equal(data.tripKm, .9177)
  assert.equal(data.lifetimeKm, 4280.855)
  assert.equal(data.controllerTemperature, 19)
  assert.equal(data.motorTemperature, 21)
  assert.equal(data.batteryTemperature, 18)
  assert.deepEqual(data.cellVoltages, Array(15).fill(null))
  assert.equal(data.pitch, 0)
  assert.equal(data.roll, 5)
  assert.equal(data.yaw, -10)
  assert.equal(data.rpm, -100)
  assert.equal(data.tripRotations, 1000)
  assert.equal(data.lifetimeMiles, 2660)
  assert.equal(data.modeCode, 8)
  assert.equal(data.tripAmpHours, null)
  assert.equal(isTelemetry(data), true)
})
test('Android angles match Python unsigned offset, sign, precision and endpoints', async () => {
  const io = fakeIo(false), session = new Session(io, identity, new AbortController().signal)
  for (const [encoded, expected] of [[0, 180], [1, 179.9], [1800, 0], [1801, -.1], [3600, -180]]) {
    Object.assign(io.values, { pitch: encoded, roll: encoded, yaw: encoded })
    const data = await session.snapshot()
    for (const name of ['pitch', 'roll', 'yaw']) assert.equal(data[name], expected)
    assert.equal(isTelemetry(data), true)
  }
  io.values.pitch = 3601
  await assert.rejects(session.snapshot(), /Invalid pitch encoding/)
  assert.deepEqual(io.writes, [])
})
test('Android extra fields match Python Ah scale, numeric serials and raw zeros without writes', async () => {
  const io = fakeIo(false), session = new Session(io, identity, new AbortController().signal)
  await session.refreshExtras()
  const data = await session.snapshot()
  assert.equal(data.tripAmpHours, .18)
  assert.equal(data.regenAmpHours, .09)
  assert.equal(data.boardSerial, 1001)
  assert.equal(data.batterySerial, 2001)
  assert.equal(data.statusFlagsRaw, 65535)
  assert.equal(data.unknown1Raw, 1234)
  assert.equal(data.headroomRaw, 0)
  assert.equal(data.lastErrorRaw, 0)
  assert.equal(isTelemetry(data), true)
  for (const name of Object.keys(EXTRA_FIELDS)) assert.ok(Object.hasOwn(data, name))
  assert.deepEqual(io.writes, [])
})
test('Android extra cache has the exact 30-second freshness boundary', async (t) => {
  let now = 100
  t.mock.method(performance, 'now', () => now)
  const session = new Session(fakeIo(false), identity, new AbortController().signal)
  await session.refreshExtras()
  now += CELL_MAX_AGE
  assert.equal((await session.snapshot()).tripAmpHours, .18)
  now += .001
  const stale = await session.snapshot()
  for (const name of Object.keys(EXTRA_FIELDS)) {
    if (!['pitch', 'roll', 'yaw'].includes(name)) assert.equal(stale[name], null)
  }
  assert.equal(stale.roll, 5)
  assert.equal(stale.current, -.054)
})
test('Android missing or malformed optional extras warn once instead of faking measurements', async (t) => {
  const io = fakeIo(false), read = io.read.bind(io)
  io.has = (uuid) => uuid !== fieldUuid('yaw')
  io.read = async (uuid) => uuid === fieldUuid('unknown1Raw') ? Uint8Array.of(1, 2, 3, 4) : read(uuid)
  const warn = t.mock.method(console, 'warn', () => {})
  const session = new Session(io, identity, new AbortController().signal)
  await session.refreshExtras()
  const data = await session.snapshot()
  await session.refreshExtras()
  await session.snapshot()
  assert.equal(warn.mock.callCount(), 2)
  assert.equal(data.yaw, null)
  assert.equal(data.unknown1Raw, null)
  assert.equal(data.packVoltage, 56.7)
  assert.equal(isTelemetry(data), true)
  assert.deepEqual(io.writes, [])
})
test('locked and invalid battery data are not accepted as measurements', async () => {
  await assert.rejects(new Session(fakeIo(), identity, new AbortController().signal).snapshot(), /locked/)
  const io = fakeIo(false)
  io.values.voltage = 0
  await assert.rejects(new Session(io, identity, new AbortController().signal).snapshot(), /Invalid battery/)
})
test('unknown motor temperature is null, not an invented room temperature', async (t) => {
  const io = fakeIo(false), read = io.read.bind(io)
  io.read = async (uuid) => uuid === fieldUuid('temperature') ? Uint8Array.of(0, 0) : read(uuid)
  const warn = t.mock.method(console, 'warn', () => {})
  const session = new Session(io, identity, new AbortController().signal)
  assert.equal((await session.snapshot()).motorTemperature, null)
  assert.equal((await session.snapshot()).controllerTemperature, 0)
  assert.equal(warn.mock.callCount(), 1)
})
test('cancellation during challenge collection prevents the response write', async () => {
  const io = fakeIo(), abort = new AbortController()
  io.subscribe = async () => {}
  const task = new Session(io, identity, abort.signal).authenticate()
  setTimeout(() => abort.abort(), 15)
  await assert.rejects(task, { name: 'AbortError' })
  assert.equal(io.stopped, true)
  assert.equal(io.writes.some((write) => write.uuid === AUTH_WRITE), false)
})
test('stream fills all 15 groups and stops every polling worker on cancellation', async () => {
  const io = fakeIo(false), abort = new AbortController()
  const session = new Session(io, identity, abort.signal)
  let complete = false
  let extrasComplete = false
  let reads = 0
  const read = io.read.bind(io)
  io.read = async (uuid) => { reads++; return read(uuid) }
  const timeout = setTimeout(() => abort.abort(new Error('Cell collection exceeded 4 seconds.')), 4000)
  try {
    await assert.rejects(session.stream((data) => {
      if (data.cellVoltages.every((v) => v !== null)) {
        complete = true
        extrasComplete = data.tripAmpHours === .18 && data.unknown1Raw === 1234
        abort.abort()
      }
    }, abort), { name: 'AbortError' })
  } finally { clearTimeout(timeout) }
  const writes = io.writes.length
  const stoppedReads = reads
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(io.writes.length, writes)
  assert.equal(reads, stoppedReads)
  assert.equal(complete, true)
  assert.equal(extrasComplete, true)
})
test('aborted delays do not leave long-running timers', async () => {
  const abort = new AbortController()
  const wait = pause(10000, abort.signal)
  abort.abort()
  await assert.rejects(wait, { name: 'AbortError' })
})
