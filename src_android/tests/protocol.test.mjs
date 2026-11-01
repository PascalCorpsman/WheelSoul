import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AUTH_READ, AUTH_WRITE, CELL_MAX_AGE, CellSamples, Session, decodeCell,
  fieldUuid, geminiResponse, pause, readIdentity, validateIdentity, word,
} from '../native/protocol.ts'

const challenge = Uint8Array.from(Buffer.from('435258000102030405060708090a0b0c0d0e0f00', 'hex'))
const response = '435258c15a4c9f0616f53b5bdde730fc15280847'
const identity = { hardware: 4206, firmware: 4134 }
function fakeIo(locked = true) {
  const values = { mode: 8, hardware: 4206, firmware: 4134, battery: 43, trip: 1000, rpm: -100, current: -27, voltage: 567, lifetime: 2660 }
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
  const timeout = setTimeout(() => abort.abort(new Error('Cell collection exceeded 4 seconds.')), 4000)
  try {
    await assert.rejects(session.stream((data) => {
      if (data.cellVoltages.every((v) => v !== null)) { complete = true; abort.abort() }
    }, abort), { name: 'AbortError' })
  } finally { clearTimeout(timeout) }
  const writes = io.writes.length
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(io.writes.length, writes)
  assert.equal(complete, true)
})
test('aborted delays do not leave long-running timers', async () => {
  const abort = new AbortController()
  const wait = pause(10000, abort.signal)
  abort.abort()
  await assert.rejects(wait, { name: 'AbortError' })
})
