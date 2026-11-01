export const APP_NAME = 'WheelSoul'
export type Domain = 'physical' | 'demo'

export interface Telemetry {
  source: Domain
  timestamp: number
  lifetimeKm: number | null
  tripKm: number | null
  packVoltage: number | null
  batteryPercent: number | null
  current: number | null
  speed: number | null
  mode: string
  cellVoltages: (number | null)[]
  motorTemperature: number | null
  controllerTemperature: number | null
  batteryTemperature: number | null
  hardware?: number | null
  firmware?: number | null
  pitch?: number | null
  roll?: number | null
  yaw?: number | null
  rpm?: number | null
  tripRotations?: number | null
  lifetimeMiles?: number | null
  modeCode?: number | null
  tripAmpHours?: number | null
  regenAmpHours?: number | null
  boardSerial?: number | null
  batterySerial?: number | null
  lowBattery5Raw?: number | null
  lowBattery20Raw?: number | null
  lightModeRaw?: number | null
  frontLightRaw?: number | null
  rearLightRaw?: number | null
  statusFlagsRaw?: number | null
  headroomRaw?: number | null
  lifetimeAmpHoursRaw?: number | null
  lastErrorRaw?: number | null
  unknown1Raw?: number | null
  unknown2Raw?: number | null
  unknown3Raw?: number | null
  unknown4Raw?: number | null
}

export interface Board {
  id: string
  advertisedName: string
  alias: string
  lastValid: Telemetry | null
  maxSpeed: number | null
}

export interface DiscoveredBoard { id: string; advertisedName: string; rssi: number }

const BASE_METRICS = [
  { id: 'lifetimeKm', label: 'Total distance', unit: 'km', precision: 1 },
  { id: 'tripKm', label: 'Current ride', unit: 'km', precision: 2 },
  { id: 'packVoltage', label: 'Pack voltage', unit: 'V', precision: 1 },
  { id: 'batteryPercent', label: 'Battery level', unit: '%', precision: 0 },
  { id: 'current', label: 'Current', unit: 'A', precision: 2 },
  { id: 'minCell', label: 'Lowest cell voltage', unit: 'V', precision: 2 },
  { id: 'maxCell', label: 'Highest cell voltage', unit: 'V', precision: 2 },
  { id: 'avgCell', label: 'Average cell voltage', unit: 'V', precision: 2 },
  { id: 'cellVoltage', label: 'Individual cell group', unit: 'V', precision: 2 },
  { id: 'imbalance', label: 'Cell imbalance', unit: 'mV', precision: 0 },
  { id: 'maxSpeed', label: 'Recorded maximum', unit: 'km/h', precision: 1 },
  { id: 'power', label: 'Electrical power', unit: 'W', precision: 0 },
  { id: 'motorTemperature', label: 'Motor temperature', unit: '°C', precision: 0 },
  { id: 'controllerTemperature', label: 'Controller temperature', unit: '°C', precision: 0 },
  { id: 'batteryTemperature', label: 'Battery temperature', unit: '°C', precision: 0 },
  { id: 'cells', label: 'All 15 cell groups', unit: 'V', precision: 2 },
] as const

export const EXTENDED_METRICS = [
  { id: 'speed', label: 'Current speed', unit: 'km/h', precision: 1 },
  { id: 'rpm', label: 'Wheel RPM (signed)', unit: 'rpm', precision: 0 },
  { id: 'pitch', label: 'Pitch', unit: '°', precision: 1 },
  { id: 'roll', label: 'Roll', unit: '°', precision: 1 },
  { id: 'yaw', label: 'Yaw', unit: '°', precision: 1 },
  { id: 'tripAmpHours', label: 'Ride consumption', unit: 'Ah', precision: 3 },
  { id: 'regenAmpHours', label: 'Ride regeneration', unit: 'Ah', precision: 3 },
  { id: 'tripRotations', label: 'Ride wheel rotations', unit: 'rot', precision: 0 },
  { id: 'lifetimeMiles', label: 'Lifetime whole miles', unit: 'mi', precision: 0 },
  { id: 'modeCode', label: 'Riding mode code', unit: '', precision: 0 },
  { id: 'hardware', label: 'Hardware revision', unit: '', precision: 0 },
  { id: 'firmware', label: 'Firmware revision', unit: '', precision: 0 },
  { id: 'boardSerial', label: 'Board serial (numeric)', unit: '', precision: 0 },
  { id: 'batterySerial', label: 'Battery serial (numeric)', unit: '', precision: 0 },
  { id: 'lowBattery5Raw', label: 'Low-battery field 304 (raw)', unit: 'raw', precision: 0 },
  { id: 'lowBattery20Raw', label: 'Low-battery field 305 (raw)', unit: 'raw', precision: 0 },
  { id: 'lightModeRaw', label: 'Light mode (raw)', unit: 'raw', precision: 0 },
  { id: 'frontLightRaw', label: 'Front light (raw)', unit: 'raw', precision: 0 },
  { id: 'rearLightRaw', label: 'Rear light (raw)', unit: 'raw', precision: 0 },
  { id: 'statusFlagsRaw', label: 'Status/error flags (raw)', unit: 'raw', precision: 0 },
  { id: 'headroomRaw', label: 'Headroom (raw, unverified)', unit: 'raw', precision: 0 },
  { id: 'lifetimeAmpHoursRaw', label: 'Lifetime Ah-related counter (raw)', unit: 'raw', precision: 0 },
  { id: 'lastErrorRaw', label: 'Last-error field (raw)', unit: 'raw', precision: 0 },
  { id: 'unknown1Raw', label: 'Unknown field 31d (raw)', unit: 'raw', precision: 0 },
  { id: 'unknown2Raw', label: 'Unknown field 31e (raw)', unit: 'raw', precision: 0 },
  { id: 'unknown3Raw', label: 'Unknown field 31f (raw)', unit: 'raw', precision: 0 },
  { id: 'unknown4Raw', label: 'Unknown field 320 (raw)', unit: 'raw', precision: 0 },
] as const
export const METRICS = [...BASE_METRICS, ...EXTENDED_METRICS] as const

export type MetricId = typeof METRICS[number]['id']
export interface Field { metric: MetricId; precision: number; cellIndex: number }
export interface BoardStore { boards: Board[]; selectedId: string | null; favoriteId: string | null }
export interface Store {
  version: 1
  settings: { demoMode: boolean; primary: Field[]; widgets: Field[]; gaugeLimit: number }
  physical: BoardStore
  demo: BoardStore
}

// Retained for compatibility with layouts saved by the original local preview.
export const STORAGE_KEY = 'onewave.dashboard.v1'

export function field(metric: MetricId): Field {
  const definition = METRICS.find((m) => m.id === metric)
  if (!definition) throw new Error('Unknown dashboard field.')
  return { metric, precision: definition.precision, cellIndex: 0 }
}

export function createStore(): Store {
  return {
    version: 1,
    settings: { demoMode: true, primary: [field('lifetimeKm'), field('tripKm'), field('packVoltage')], widgets: [], gaugeLimit: 40 },
    physical: { boards: [], selectedId: null, favoriteId: null },
    demo: {
      boards: [
        { id: 'demo-xr-1', advertisedName: 'Demo XR 01', alias: 'My XR', lastValid: demoTelemetry('demo-xr-1', 0), maxSpeed: 26.4 },
        { id: 'demo-xr-2', advertisedName: 'Demo XR 02', alias: 'Second board', lastValid: demoTelemetry('demo-xr-2', 0), maxSpeed: 22.8 },
      ],
      selectedId: 'demo-xr-1', favoriteId: null,
    },
  }
}

export function demoTelemetry(id: string, elapsed: number, moving = false): Telemetry {
  if (!['demo-xr-1', 'demo-xr-2'].includes(id)) throw new Error('Unknown demo board.')
  const second = id === 'demo-xr-2'
  const speed = moving ? Math.max(0, 16 + 11 * Math.sin(elapsed / 8)) : 0
  return {
    source: 'demo', timestamp: Date.now(),
    lifetimeKm: (second ? 1286.3 : 4280.9) + (moving ? elapsed * 0.004 : 0),
    tripKm: moving ? elapsed * 0.004 : 0,
    packVoltage: second ? 58.5 : 56.7, batteryPercent: second ? 68 : 43,
    current: moving ? 3 + 5 * Math.sin(elapsed / 8) : 0.054,
    speed,
    mode: second ? 'Mission' : 'Delirium',
    cellVoltages: Array.from({ length: 15 }, (_, i) => second ? (i === 6 ? 3.88 : 3.9) : 3.8),
    motorTemperature: moving ? 29 : 19, controllerTemperature: moving ? 25 : 19, batteryTemperature: 18,
    hardware: 4206, firmware: 4134,
    pitch: moving ? 6 * Math.sin(elapsed / 3) : 0,
    roll: moving ? 4 * Math.cos(elapsed / 4) : 0,
    yaw: moving ? 30 * Math.sin(elapsed / 6) : 0,
    rpm: Math.round(speed * 1000 / (0.91766 * 60)),
    tripRotations: moving ? Math.floor(elapsed * 4) % 65536 : 0,
    lifetimeMiles: second ? 799 : 2660,
    modeCode: second ? 6 : 8,
    tripAmpHours: moving ? (Math.floor(elapsed * 0.0008 / 0.00018) % 65536) * 0.00018 : 0,
    regenAmpHours: moving ? (Math.floor(elapsed * 0.0001 / 0.00018) % 65536) * 0.00018 : 0,
    boardSerial: second ? 1002 : 1001, batterySerial: second ? 2002 : 2001,
    lowBattery5Raw: null, lowBattery20Raw: null,
    lightModeRaw: null, frontLightRaw: null, rearLightRaw: null, statusFlagsRaw: null,
    headroomRaw: null, lifetimeAmpHoursRaw: null, lastErrorRaw: null,
    unknown1Raw: null, unknown2Raw: null, unknown3Raw: null, unknown4Raw: null,
  }
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberOrNull(value: unknown, min = -Infinity, max = Infinity): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max)
}

function optionalNumber(value: unknown, min: number, max: number, integer = false): boolean {
  return value === undefined || (numberOrNull(value, min, max) &&
    (value === null || !integer || Number.isInteger(value)))
}

export function isTelemetry(value: unknown): value is Telemetry {
  return record(value) && (value.source === 'demo' || value.source === 'physical') &&
    typeof value.timestamp === 'number' && Number.isFinite(value.timestamp) && value.timestamp > 0 && value.timestamp <= 8.64e15 &&
    numberOrNull(value.lifetimeKm, 0) && numberOrNull(value.tripKm, 0) &&
    numberOrNull(value.packVoltage, Number.MIN_VALUE, 80) && numberOrNull(value.batteryPercent, 0, 100) &&
    numberOrNull(value.current) && numberOrNull(value.speed, 0) &&
    typeof value.mode === 'string' && value.mode.length > 0 &&
    Array.isArray(value.cellVoltages) && value.cellVoltages.length === 15 &&
    value.cellVoltages.every((v) => numberOrNull(v, Number.MIN_VALUE, 5)) &&
    numberOrNull(value.motorTemperature) && numberOrNull(value.controllerTemperature) && numberOrNull(value.batteryTemperature) &&
    ['pitch', 'roll', 'yaw'].every((key) => optionalNumber(value[key], -180, 180)) &&
    optionalNumber(value.rpm, -32768, 32767, true) &&
    ['tripAmpHours', 'regenAmpHours'].every((key) => optionalNumber(value[key], 0, 65535 * 0.00018)) &&
    ['hardware', 'firmware', 'tripRotations', 'lifetimeMiles', 'modeCode', 'boardSerial', 'batterySerial',
      'lowBattery5Raw', 'lowBattery20Raw', 'lightModeRaw', 'frontLightRaw', 'rearLightRaw',
      'statusFlagsRaw', 'headroomRaw', 'lifetimeAmpHoursRaw', 'lastErrorRaw',
      'unknown1Raw', 'unknown2Raw', 'unknown3Raw', 'unknown4Raw',
    ].every((key) => optionalNumber(value[key], 0, 65535, true))
}

function isField(value: unknown): value is Field {
  return record(value) && METRICS.some((m) => m.id === value.metric) &&
    typeof value.precision === 'number' && Number.isInteger(value.precision) && value.precision >= 0 && value.precision <= 3 &&
    typeof value.cellIndex === 'number' && Number.isInteger(value.cellIndex) && value.cellIndex >= 0 && value.cellIndex < 15
}

function isBoard(value: unknown, domain: Domain): value is Board {
  return record(value) && typeof value.id === 'string' && value.id.length > 0 &&
    typeof value.advertisedName === 'string' && typeof value.alias === 'string' &&
    value.alias.trim().length > 0 && value.alias.length <= 40 && numberOrNull(value.maxSpeed, 0) &&
    (value.lastValid === null || (isTelemetry(value.lastValid) && value.lastValid.source === domain))
}

function isBoardStore(value: unknown, domain: Domain): value is BoardStore {
  if (!record(value) || !Array.isArray(value.boards) || !value.boards.every((b) => isBoard(b, domain))) return false
  const ids = value.boards.map((b: Board) => b.id)
  return new Set(ids).size === ids.length &&
    (value.selectedId === null || (typeof value.selectedId === 'string' && ids.includes(value.selectedId))) &&
    (value.favoriteId === null || (typeof value.favoriteId === 'string' && ids.includes(value.favoriteId)))
}

export function parseStore(text: string): Store {
  const value: unknown = JSON.parse(text)
  if (!record(value) || value.version !== 1 || !record(value.settings)) throw new Error('Unknown saved WheelSoul data format.')
  const settings = value.settings
  if (
    typeof settings.demoMode !== 'boolean' ||
    !Array.isArray(settings.primary) || settings.primary.length !== 3 || !settings.primary.every(isField) ||
    settings.primary.some((f: Field) => f.metric === 'cells') ||
    !Array.isArray(settings.widgets) || !settings.widgets.every(isField) ||
    typeof settings.gaugeLimit !== 'number' || ![30, 40, 50, 60].includes(settings.gaugeLimit) ||
    !isBoardStore(value.physical, 'physical') || !isBoardStore(value.demo, 'demo')
  ) throw new Error('Saved board data or dashboard settings are invalid.')
  return { version: 1, settings: {
    demoMode: settings.demoMode, primary: settings.primary, widgets: settings.widgets, gaugeLimit: settings.gaugeLimit,
  }, physical: value.physical, demo: value.demo }
}

export function selectedBoard(store: Store): Board | undefined {
  const domain = store.settings.demoMode ? store.demo : store.physical
  return domain.boards.find((b) => b.id === domain.selectedId)
}

export function addDiscovered(store: Store, discovered: { id: string; advertisedName: string }[]): Store {
  const boards = [...store.physical.boards]
  for (const found of discovered) {
    const index = boards.findIndex((b) => b.id === found.id)
    if (index >= 0) boards[index] = { ...boards[index], advertisedName: found.advertisedName }
    else boards.push({ id: found.id, advertisedName: found.advertisedName, alias: found.advertisedName, lastValid: null, maxSpeed: null })
  }
  return { ...store, physical: { ...store.physical, boards, selectedId: store.physical.selectedId ?? boards[0]?.id ?? null } }
}

function updateBoard(store: Store, domain: Domain, id: string, change: (b: Board) => Board): Store {
  if (!store[domain].boards.some((b) => b.id === id)) throw new Error('Board is not saved.')
  return { ...store, [domain]: { ...store[domain], boards: store[domain].boards.map((b) => {
    if (b.id !== id) return b
    const updated = change(b)
    if (updated.id !== id || !isBoard(updated, domain)) throw new Error('Invalid board update.')
    return updated
  }) } }
}

export function renameBoard(store: Store, domain: Domain, id: string, name: string): Store {
  const alias = name.trim()
  if (!alias || alias.length > 40) throw new Error('Enter a name containing 1 to 40 characters.')
  return updateBoard(store, domain, id, (b) => ({ ...b, alias }))
}

export function ingestTelemetry(store: Store, domain: Domain, id: string, data: unknown): Store {
  if (!isTelemetry(data) || data.source !== domain || data.packVoltage === null || data.mode === '0') {
    throw new Error('Invalid measurement or data source. The last valid sample is retained.')
  }
  return updateBoard(store, domain, id, (b) => {
    if (b.lastValid && data.timestamp < b.lastValid.timestamp) throw new Error('Outdated measurement rejected.')
    return { ...b, lastValid: data, maxSpeed: data.speed === null ? b.maxSpeed : Math.max(b.maxSpeed ?? 0, data.speed) }
  })
}

export function moveWidget(store: Store, index: number, direction: -1 | 1): Store {
  const target = index + direction
  if (!Number.isInteger(index) || index < 0 || index >= store.settings.widgets.length || target < 0 || target >= store.settings.widgets.length) {
    throw new Error('This field cannot be moved to that position.')
  }
  const widgets = [...store.settings.widgets]
  const item = widgets[index]
  widgets[index] = widgets[target]
  widgets[target] = item
  return { ...store, settings: { ...store.settings, widgets } }
}

export function favoriteToConnect(store: Store, context: {
  bluetoothOn: boolean; foreground: boolean; busy: boolean; manuallyDisconnected: boolean; visibleIds: string[]
}): string | null {
  if (store.settings.demoMode || !context.bluetoothOn || !context.foreground || context.busy ||
    context.manuallyDisconnected || !store.physical.favoriteId || !context.visibleIds.includes(store.physical.favoriteId)) return null
  return store.physical.favoriteId
}

export function fieldValue(board: Board | undefined, item: Field): number | null {
  const data = board?.lastValid
  if (item.metric === 'maxSpeed') return board?.maxSpeed ?? null
  if (!data) return null
  const cells = data.cellVoltages.filter((v): v is number => v !== null)
  const complete = cells.length === 15
  switch (item.metric) {
    case 'minCell': return complete ? Math.min(...cells) : null
    case 'maxCell': return complete ? Math.max(...cells) : null
    case 'avgCell': return complete ? cells.reduce((a, b) => a + b, 0) / 15 : null
    case 'imbalance': return complete ? (Math.max(...cells) - Math.min(...cells)) * 1000 : null
    case 'cellVoltage': return data.cellVoltages[item.cellIndex]
    case 'motorTemperature':
      return data.source === 'physical' && data.motorTemperature === 0 ? null : data.motorTemperature
    case 'power': return data.current !== null && data.packVoltage !== null ? data.current * data.packVoltage : null
    case 'cells': return null
    default: return data[item.metric] ?? null
  }
}

export function fieldLabel(item: Field): string {
  return item.metric === 'cellVoltage' ? `Cell group ${item.cellIndex + 1}` : METRICS.find((m) => m.id === item.metric)?.label ?? 'Unknown field'
}

export function formatValue(value: number | null, precision: number): string {
  return value === null ? '-' : new Intl.NumberFormat('en-GB', { minimumFractionDigits: precision, maximumFractionDigits: precision }).format(value)
}

export function gaugeAngle(speed: number | null, limit: number): number {
  return -120 + Math.min(1, Math.max(0, (speed ?? 0) / limit)) * 240
}
