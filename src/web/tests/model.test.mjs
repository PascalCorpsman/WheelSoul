import test from 'node:test'
import assert from 'node:assert/strict'
import {
  addDiscovered, createStore, demoTelemetry, field, fieldValue, favoriteToConnect,
  EXTENDED_METRICS, METRICS, formatValue, gaugeAngle, ingestTelemetry, isTelemetry,
  moveWidget, parseStore, renameBoard, selectedBoard,
} from '../model.ts'
import { parseDiscovered, parseEvent } from '../bridge.ts'

function physical() {
  let store = addDiscovered(createStore(), [
    { id: 'board-a', advertisedName: 'XR Alpha' },
    { id: 'board-b', advertisedName: 'XR Beta' },
  ])
  store.settings.demoMode = false
  store = ingestTelemetry(store, 'physical', 'board-a', { ...demoTelemetry('demo-xr-1', 0), source: 'physical' })
  return store
}

test('simple defaults and English labels', () => {
  const store = createStore()
  assert.deepEqual(store.settings.primary.map((f) => f.metric), ['lifetimeKm', 'tripKm', 'packVoltage'])
  assert.equal(store.settings.widgets.length, 0)
  assert.equal(store.settings.demoMode, true)
  assert.equal(store.physical.boards.length, 0)
  assert.equal(selectedBoard(store).alias, 'My XR')
})

test('discovery never overwrites aliases, history or maxima', () => {
  let store = renameBoard(physical(), 'physical', 'board-a', 'Winter XR')
  const before = store.physical.boards[0]
  store = addDiscovered(store, [{ id: 'board-a', advertisedName: 'Changed advertisement' }])
  assert.equal(store.physical.boards[0].alias, 'Winter XR')
  assert.deepEqual(store.physical.boards[0].lastValid, before.lastValid)
  assert.equal(store.physical.boards[0].maxSpeed, before.maxSpeed)
})

test('board-specific cache and alias survive reload', () => {
  let store = renameBoard(physical(), 'physical', 'board-b', 'Summer XR')
  store = ingestTelemetry(store, 'physical', 'board-b', { ...demoTelemetry('demo-xr-2', 0), source: 'physical', speed: 29 })
  store.physical.selectedId = 'board-b'
  store.physical.favoriteId = 'board-b'
  const loaded = parseStore(JSON.stringify(store))
  assert.equal(selectedBoard(loaded).alias, 'Summer XR')
  assert.equal(selectedBoard(loaded).maxSpeed, 29)
  assert.equal(selectedBoard(loaded).lastValid.lifetimeKm, 1286.3)
  loaded.physical.selectedId = 'board-a'
  assert.equal(selectedBoard(loaded).lastValid.lifetimeKm, 4280.9)
})

test('demo data never overwrites physical cache', () => {
  const store = physical()
  assert.throws(() => ingestTelemetry(store, 'physical', 'board-a', demoTelemetry('demo-xr-1', 0)))
  const next = ingestTelemetry(store, 'demo', 'demo-xr-1', demoTelemetry('demo-xr-1', 8, true))
  assert.deepEqual(next.physical, store.physical)
})

test('invalid or stale data preserves last valid sample', () => {
  const store = physical(), data = store.physical.boards[0].lastValid
  for (const invalid of [
    { ...data, speed: NaN }, { ...data, packVoltage: 0 }, { ...data, packVoltage: null },
    { ...data, mode: '0' }, { ...data, timestamp: data.timestamp - 1 }, { ...data, cellVoltages: [] },
  ]) assert.throws(() => ingestTelemetry(store, 'physical', 'board-a', invalid))
  assert.equal(store.physical.boards[0].lastValid, data)
})

test('cell calculations require 15 valid groups', () => {
  const store = createStore()
  store.demo.selectedId = 'demo-xr-2'
  const board = selectedBoard(store)
  assert.equal(fieldValue(board, field('minCell')), 3.88)
  assert.equal(fieldValue(board, field('maxCell')), 3.9)
  assert.equal(formatValue(fieldValue(board, field('imbalance')), 0), '20')
  assert.equal(fieldValue(board, { ...field('cellVoltage'), cellIndex: 6 }), 3.88)
  board.lastValid.cellVoltages[0] = null
  for (const metric of ['minCell', 'maxCell', 'avgCell', 'imbalance']) assert.equal(fieldValue(board, field(metric)), null)
})

test('missing readings are not zero measurements', () => {
  assert.equal(fieldValue(undefined, field('packVoltage')), null)
  assert.equal(formatValue(null, 2), '-')
  assert.equal(formatValue(0, 2), '0.00')
})

test('all 43 telemetry widgets persist for the shared browser and Android dashboard', () => {
  assert.equal(METRICS.length, 43)
  assert.equal(new Set(METRICS.map((item) => item.id)).size, METRICS.length)
  assert.ok(METRICS.some((item) => item.id === 'pitch'))
  const store = physical()
  store.settings.primary[0] = field('pitch')
  store.settings.widgets = EXTENDED_METRICS.map((metric) => field(metric.id))
  const loaded = parseStore(JSON.stringify(store))
  assert.equal(loaded.settings.primary[0].metric, 'pitch')
  assert.equal(loaded.settings.widgets.length, EXTENDED_METRICS.length)
  const board = loaded.physical.boards[0]
  assert.equal(fieldValue(board, field('pitch')), 0)
  assert.equal(fieldValue(board, field('firmware')), 4134)
  assert.equal(fieldValue(board, field('unknown1Raw')), null)
  assert.equal(formatValue(fieldValue(board, field('unknown1Raw')), 0), '-')
})

test('old browser and native telemetry without new fields remains valid and unknown, not zero', () => {
  const store = physical(), board = store.physical.boards[0]
  for (const metric of EXTENDED_METRICS) if (metric.id !== 'speed') delete board.lastValid[metric.id]
  assert.equal(isTelemetry(board.lastValid), true)
  store.settings.widgets = [field('pitch'), field('tripAmpHours')]
  const loaded = parseStore(JSON.stringify(store))
  assert.equal(fieldValue(loaded.physical.boards[0], field('pitch')), null)
  assert.equal(fieldValue(loaded.physical.boards[0], field('tripAmpHours')), null)
  assert.equal(loaded.physical.boards[0].alias, board.alias)
  assert.equal(loaded.physical.boards[0].maxSpeed, board.maxSpeed)
})

test('new optional telemetry is validated before replacing physical cached readings', () => {
  const store = physical(), previous = store.physical.boards[0].lastValid
  for (const invalid of [
    { pitch: -180.1 }, { roll: 180.1 }, { yaw: '0' }, { pitch: Infinity },
    { rpm: 32768 }, { rpm: .5 }, { tripAmpHours: -.001 }, { regenAmpHours: 12 },
    { statusFlagsRaw: 65536 }, { unknown1Raw: 1.5 }, { hardware: -1 }, { firmware: '4134' },
  ]) {
    const data = { ...previous, ...invalid }
    assert.equal(isTelemetry(data), false)
    assert.throws(() => ingestTelemetry(store, 'physical', 'board-a', data), /Invalid measurement/)
    assert.equal(store.physical.boards[0].lastValid, previous)
  }
  assert.equal(isTelemetry({ ...previous, pitch: -180, roll: 180, yaw: null, statusFlagsRaw: 65535 }), true)
  assert.equal(isTelemetry(demoTelemetry('demo-xr-1', 100000, true)), true)
})

test('legacy cached motor zero is unknown without hiding valid zero measurements', () => {
  const store = physical(), board = store.physical.boards[0]
  board.lastValid.motorTemperature = 0
  board.lastValid.controllerTemperature = 0
  board.lastValid.batteryTemperature = 0
  board.lastValid.current = 0
  assert.equal(fieldValue(board, field('motorTemperature')), null)
  for (const metric of ['controllerTemperature', 'batteryTemperature', 'current', 'imbalance']) {
    assert.equal(fieldValue(board, field(metric)), 0)
  }
  const loaded = parseStore(JSON.stringify(store))
  assert.equal(fieldValue(selectedBoard(loaded), field('motorTemperature')), null)
  board.lastValid.motorTemperature = 20
  assert.equal(fieldValue(board, field('motorTemperature')), 20)
  board.lastValid.motorTemperature = null
  assert.equal(formatValue(fieldValue(board, field('motorTemperature')), 0), '-')
})

test('configuration and arbitrary individual-cell widgets persist', () => {
  const store = createStore()
  store.settings.primary[2] = field('avgCell')
  store.settings.widgets = [field('minCell'), field('maxCell'), { ...field('cellVoltage'), cellIndex: 14 }]
  const moved = moveWidget(store, 1, -1)
  const loaded = parseStore(JSON.stringify(moved))
  assert.equal(loaded.settings.widgets[0].metric, 'maxCell')
  assert.equal(loaded.settings.widgets[2].cellIndex, 14)
  assert.equal(loaded.settings.primary[2].metric, 'avgCell')
  assert.throws(() => moveWidget(store, 0, -1))
})

test('favorite conditions include visibility, foreground, radio, busy state and manual disconnect', () => {
  const store = physical()
  store.physical.favoriteId = 'board-a'
  const ready = { bluetoothOn: true, foreground: true, busy: false, manuallyDisconnected: false, visibleIds: ['board-a'] }
  assert.equal(favoriteToConnect(store, ready), 'board-a')
  for (const blocked of [
    { bluetoothOn: false }, { foreground: false }, { busy: true }, { manuallyDisconnected: true }, { visibleIds: [] },
  ]) assert.equal(favoriteToConnect(store, { ...ready, ...blocked }), null)
  store.settings.demoMode = true
  assert.equal(favoriteToConnect(store, ready), null)
})

test('maximum is board-specific and never replaced by a lower reading', () => {
  const store = physical(), data = store.physical.boards[0].lastValid
  const high = ingestTelemetry(store, 'physical', 'board-a', { ...data, timestamp: Date.now() + 100, speed: 30 })
  const low = ingestTelemetry(high, 'physical', 'board-a', { ...data, timestamp: Date.now() + 200, speed: 1 })
  assert.equal(low.physical.boards[0].maxSpeed, 30)
  assert.equal(low.physical.boards[1].maxSpeed, null)
  assert.equal(gaugeAngle(70, 40), 120)
})

test('corrupt storage and cross-domain cache are rejected', () => {
  assert.throws(() => parseStore('{'))
  const store = createStore()
  store.physical.boards = store.demo.boards
  assert.throws(() => parseStore(JSON.stringify(store)))
  store.physical.boards = []
  store.demo.favoriteId = 'missing'
  assert.throws(() => parseStore(JSON.stringify(store)))
})

test('rename rejects invalid names and does not rename the advertised device', () => {
  const store = physical()
  const next = renameBoard(store, 'physical', 'board-a', '  Winter XR  ')
  assert.equal(next.physical.boards[0].alias, 'Winter XR')
  assert.equal(next.physical.boards[0].advertisedName, 'XR Alpha')
  for (const name of ['', ' ', 'x'.repeat(41)]) assert.throws(() => renameBoard(store, 'physical', 'board-a', name))
})

test('bridge rejects fake telemetry and malformed discovered devices', () => {
  assert.throws(() => parseEvent({ type: 'telemetry', boardId: 'a', data: demoTelemetry('demo-xr-1', 0) }))
  assert.throws(() => parseEvent({ type: 'state', status: 'unknown', boardId: null, boardName: null, error: null }))
  assert.throws(() => parseEvent({ type: 'state', status: 'connected', boardId: null, boardName: null, error: null }))
  assert.throws(() => parseEvent({ type: 'state', status: 'error', boardId: null, boardName: null, error: null }))
  assert.throws(() => parseDiscovered({ boards: [{ id: 'a', advertisedName: 'XR', rssi: 'weak' }] }))
  const found = parseDiscovered({ boards: [{ id: 'dynamic-id', advertisedName: 'XR', rssi: -70 }] })
  assert.equal(found[0].id, 'dynamic-id')
  const event = parseEvent({ type: 'telemetry', boardId: 'dynamic-id', data: { ...demoTelemetry('demo-xr-1', 0), source: 'physical' } })
  assert.equal(event.boardId, 'dynamic-id')
})
