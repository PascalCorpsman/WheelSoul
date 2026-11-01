import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { displayVersion } from '../../package.json'
import iconUrl from '../../src_android/branding/icon.svg'
import {
  APP_NAME, METRICS, STORAGE_KEY, addDiscovered, createStore, demoTelemetry,
  favoriteToConnect, field, fieldLabel, fieldValue, formatValue, gaugeAngle,
  ingestTelemetry, moveWidget, parseStore, renameBoard, selectedBoard,
} from './model'
import type { Board, DiscoveredBoard, Domain, Field, Store } from './model'
import { OFFLINE } from './bridge'
import type { Availability, Connection, SampleEvent, Transport } from './bridge'
import { IS_ANDROID, createTransport } from './runtime'
import { RELEASES_URL, checkForUpdate } from './updates'
import type { Update } from './updates'

function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error) }
function load() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    return { store: saved ? parseStore(saved) : createStore(), error: null }
  } catch (error) { return { store: createStore(), error: errorMessage(error) } }
}

function Icon({ name }: { name: 'wheel' | 'settings' | 'chevron' | 'star' | 'edit' | 'close' | 'plus' | 'up' | 'down' }) {
  const paths = {
    settings: 'M4 7h16M4 17h16M8 4v6M16 14v6',
    chevron: 'm6 9 6 6 6-6', star: 'm12 3 2.8 5.7 6.3.9-4.5 4.4 1 6.2-5.6-3-5.6 3 1-6.2L3 9.6l6.2-.9Z',
    edit: 'm15 4 5 5M4 20l1-6L16 3l5 5L10 19Z', close: 'm6 6 12 12M6 18 18 6',
    plus: 'M12 5v14M5 12h14', up: 'm6 15 6-6 6 6', down: 'm6 9 6 6 6-6',
  }
  return <svg viewBox={name === 'wheel' ? '0 0 108 108' : '0 0 24 24'} width="20" height="20" fill={name === 'wheel' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.7"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === 'wheel' ? <use href={`${iconUrl}#wheelsoul-mark`} /> : <path d={paths[name]} />}
  </svg>
}

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const id = useId()
  useEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])
  return <dialog ref={ref} aria-labelledby={id} onCancel={(e) => { e.preventDefault(); onClose() }}
    onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
    <div className="dialog-inner"><header className="dialog-header"><h2 id={id}>{title}</h2>
      <button className="icon-button" aria-label={`Close ${title}`} onClick={onClose}><Icon name="close" /></button>
    </header>{children}</div>
  </dialog>
}

function point(angle: number, radius: number) {
  const radians = angle * Math.PI / 180
  return { x: 180 + Math.sin(radians) * radius, y: 150 - Math.cos(radians) * radius }
}

function Gauge({ speed, max, limit, live }: { speed: number | null; max: number | null; limit: number; live: boolean }) {
  const start = point(-120, 130), end = point(120, 130)
  const needle = point(gaugeAngle(speed, limit), 101)
  const heldStart = point(gaugeAngle(max, limit), 111), heldEnd = point(gaugeAngle(max, limit), 128)
  return <section className={`gauge ${live ? 'live' : 'saved'}`} aria-label="Speed gauge">
    <div className="gauge-caption">{live ? 'Speed' : 'Last measured speed'}</div>
    <svg viewBox="0 0 360 260" role="img" aria-label={`${formatValue(speed, 1)} km/h; recorded maximum ${formatValue(max, 1)} km/h`}>
      <path d={`M ${start.x} ${start.y} A 130 130 0 1 1 ${end.x} ${end.y}`} className="gauge-track" fill="none" />
      {Array.from({ length: 21 }, (_, i) => {
        const angle = -120 + i * 12, outer = point(angle, 128), inner = point(angle, i % 5 === 0 ? 115 : 122), label = point(angle, 98)
        return <g key={i}><line x1={outer.x} y1={outer.y} x2={inner.x} y2={inner.y} className="gauge-tick" />
          {i % 5 === 0 && <text x={label.x} y={label.y + 5} className="gauge-number">{i * limit / 20}</text>}</g>
      })}
      {max !== null && <line x1={heldStart.x} y1={heldStart.y} x2={heldEnd.x} y2={heldEnd.y} className="held-needle" />}
      {speed !== null && <line x1="180" y1="150" x2={needle.x} y2={needle.y} className="speed-needle" />}
      <circle cx="180" cy="150" r="5" className="needle-center" />
      <text x="180" y="207" className="gauge-value">{formatValue(speed, 1)}</text><text x="180" y="230" className="gauge-unit">km/h</text>
    </svg>
    <div className="max-caption"><span className="max-marker" /> Maximum {formatValue(max, 1)} km/h</div>
    {((speed ?? 0) > limit || (max ?? 0) > limit) && <p className="small-note">A pointer is outside the selected scale.</p>}
  </section>
}

function MetricCard({ board, item, primary = false }: { board: Board | undefined; item: Field; primary?: boolean }) {
  if (item.metric === 'cells') return <article className="metric-card cell-card"><h3>All 15 cell groups</h3>
    <div className="cells-grid">{Array.from({ length: 15 }, (_, i) => <div key={i}>
      <span>C{String(i + 1).padStart(2, '0')}</span><strong>{formatValue(board?.lastValid?.cellVoltages[i] ?? null, item.precision)}</strong><small>V</small>
    </div>)}</div><p className="small-note">20 mV resolution on Gemini 4134. Not a safety-critical battery diagnosis.</p>
  </article>
  return <article className={`metric-card ${primary ? 'primary-card' : ''}`}><h3>{fieldLabel(item)}</h3>
    <div className="metric-value"><strong>{formatValue(fieldValue(board, item), item.precision)}</strong>
      <span>{METRICS.find((m) => m.id === item.metric)?.unit}</span></div>
  </article>
}

function FieldEditor({ item, label, primary, onChange }: { item: Field; label: string; primary?: boolean; onChange: (f: Field) => void }) {
  const id = useId()
  return <div className="field-editor"><label htmlFor={id}>{label}</label>
    <select id={id} value={item.metric} onChange={(e) => {
      const metric = METRICS.find((m) => m.id === e.target.value)
      if (!metric) throw new Error('Unknown dashboard field.')
      onChange(field(metric.id))
    }}>{METRICS.filter((m) => !primary || m.id !== 'cells').map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select>
    <div className="field-options"><label>Decimal places<select aria-label={`${label} decimal places`} value={item.precision}
      onChange={(e) => onChange({ ...item, precision: Number(e.target.value) })}>
      {[0, 1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}
    </select></label>
      {item.metric === 'cellVoltage' && <label>Cell group<select aria-label={`${label} cell group`} value={item.cellIndex}
        onChange={(e) => onChange({ ...item, cellIndex: Number(e.target.value) })}>
        {Array.from({ length: 15 }, (_, i) => <option key={i} value={i}>{i + 1}</option>)}
      </select></label>}
    </div>
  </div>
}

function UpdatePanel() {
  const [state, setState] = useState<
    { status: 'idle' | 'checking' | 'current' } |
    { status: 'available'; update: Update } |
    { status: 'error'; message: string }
  >({ status: 'idle' })
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => {
    const controller = request.current
    request.current = null
    controller?.abort()
  }, [])

  async function check() {
    if (request.current) return
    const controller = new AbortController()
    request.current = controller
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, 10_000)
    setState({ status: 'checking' })
    try {
      const update = await checkForUpdate(displayVersion, controller.signal)
      if (request.current === controller) setState(update ? { status: 'available', update } : { status: 'current' })
    } catch (error) {
      if (request.current === controller) setState({
        status: 'error', message: timedOut ? 'Update check timed out. Check your Internet connection and try again.' : errorMessage(error),
      })
    } finally {
      clearTimeout(timer)
      if (request.current === controller) request.current = null
    }
  }

  return <div className="info-box">
    <strong>Android updates · Version {displayVersion}</strong>
    <p>Check GitHub for newer APKs, including preview releases. No account is needed.</p>
    <button className="text-button" disabled={state.status === 'checking'} onClick={() => { void check() }}>
      {state.status === 'checking' ? 'Checking GitHub…' : 'Check for updates'}
    </button>
    {state.status === 'current' && <p role="status">No newer Android APK is available.</p>}
    {state.status === 'available' && <p role="status">WheelSoul {state.update.version} is available.{' '}
      <a href={state.update.url} target={IS_ANDROID ? undefined : '_blank'} rel="noopener noreferrer">Open GitHub download</a>
    </p>}
    {state.status === 'error' && <div className="notice error" role="alert">{state.message}</div>}
    <p><a href={RELEASES_URL} target={IS_ANDROID ? undefined : '_blank'} rel="noopener noreferrer">All GitHub releases</a></p>
    <p>Download the APK in your browser and confirm installation in Android. Nothing is installed automatically.
      {IS_ANDROID && ' Opening GitHub leaves WheelSoul and disconnects BLE.'}</p>
  </div>
}

export default function App() {
  const [initial] = useState(load)
  const [store, setStore] = useState(initial.store)
  const storeRef = useRef(store)
  const savePaused = useRef(initial.error !== null)
  const [loadError, setLoadError] = useState(initial.error)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [panel, setPanel] = useState<'boards' | 'settings' | null>(null)
  const [rename, setRename] = useState<{ domain: Domain; id: string; name: string } | null>(null)
  const [demoId, setDemoId] = useState<string | null>(null)
  const [moving, setMoving] = useState(false)
  const [connection, setConnection] = useState<Connection>(OFFLINE)
  const connectionRef = useRef(connection)
  const [frameId, setFrameId] = useState<string | null>(null)
  const [availability, setAvailability] = useState<Availability>({ ready: false, enabled: false, error: null })
  const bridge = useRef<Transport | null>(null)
  const [visible, setVisible] = useState<DiscoveredBoard[]>([])
  const [scanning, setScanning] = useState(false)
  const scanPromise = useRef<Promise<DiscoveredBoard[]> | null>(null)
  const manuallyDisconnected = useRef(false)
  const [foreground, setForeground] = useState(document.visibilityState === 'visible')
  const demoMode = store.settings.demoMode
  const domain: Domain = demoMode ? 'demo' : 'physical'
  const boards = store[domain]
  const board = selectedBoard(store)
  const physicalActive = connection.status === 'connected' || connection.status === 'connecting'
  const active = demoMode ? demoId !== null : physicalActive
  const live = demoMode ? demoId === board?.id : connection.status === 'connected' && connection.boardId === board?.id && frameId === board?.id
  const report = useCallback((error: unknown) => setMessage(errorMessage(error)), [])

  const change = useCallback((transform: (previous: Store) => Store) => {
    try {
      const next = transform(storeRef.current)
      if (!savePaused.current) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) }
        catch (error) { savePaused.current = true; setSaveError(errorMessage(error)) }
      }
      storeRef.current = next
      setStore(next)
      return true
    } catch (error) { report(error); return false }
  }, [report])

  useEffect(() => {
    let cancelled = false
    let client: Transport | null = null
    const onEvent = (event: Connection | SampleEvent) => {
      if (event.type === 'state') {
        connectionRef.current = event
        setConnection(event)
        if (event.status !== 'connected') setFrameId(null)
        const { boardId, boardName } = event
        if (boardId && boardName) change((previous) => addDiscovered(previous, [{ id: boardId, advertisedName: boardName }]))
        if (event.error) report(event.error)
      } else {
        const valid = change((previous) => {
          const known = previous.physical.boards.some((b) => b.id === event.boardId) ? previous :
            addDiscovered(previous, [{ id: event.boardId, advertisedName: 'Onewheel' }])
          return ingestTelemetry(known, 'physical', event.boardId, event.data)
        })
        setFrameId(valid ? event.boardId : null)
      }
    }
    void createTransport(onEvent, setAvailability, report, setForeground).then((created) => {
      if (cancelled) { created.stop(); return }
      client = created
      bridge.current = created
      return created.start()
    }).catch(report)
    return () => { cancelled = true; client?.stop(); bridge.current = null }
  }, [change, report])

  useEffect(() => {
    if (IS_ANDROID) return
    const listener = () => setForeground(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', listener)
    return () => document.removeEventListener('visibilitychange', listener)
  }, [])

  const scan = useCallback((): Promise<DiscoveredBoard[]> => {
    if (scanPromise.current) return scanPromise.current
    const client = bridge.current
    if (!client) return Promise.reject(new Error('Bluetooth interface is not ready.'))
    setScanning(true)
    const request = client.scan().then((found) => {
      setVisible(found)
      change((previous) => addDiscovered(previous, found))
      return found
    }).finally(() => { scanPromise.current = null; setScanning(false) })
    scanPromise.current = request
    return request
  }, [change])

  useEffect(() => {
    if (demoMode || !availability.ready || !availability.enabled || !foreground || !store.physical.favoriteId || physicalActive) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const search = async () => {
      let delay = 10000
      try {
        if (manuallyDisconnected.current) return
        const found = await scan()
        if (cancelled) return
        const candidate = favoriteToConnect(storeRef.current, {
          bluetoothOn: true, foreground: document.visibilityState === 'visible',
          busy: ['connected', 'connecting'].includes(connectionRef.current.status),
          manuallyDisconnected: manuallyDisconnected.current, visibleIds: found.map((b) => b.id),
        })
        if (candidate && bridge.current) {
          change((previous) => ({ ...previous, physical: { ...previous.physical, selectedId: candidate } }))
          await bridge.current.connect(candidate)
        }
      } catch (error) { report(error); delay = 30000 }
      finally { if (!cancelled && !manuallyDisconnected.current) timer = setTimeout(() => { void search() }, delay) }
    }
    void search()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [demoMode, availability.ready, availability.enabled, foreground, store.physical.favoriteId, physicalActive, scan, change, report])

  useEffect(() => {
    if (!demoMode || !demoId) return
    let elapsed = 0
    const timer = setInterval(() => {
      elapsed++
      if (!change((previous) => ingestTelemetry(previous, 'demo', demoId, demoTelemetry(demoId, elapsed, moving)))) setDemoId(null)
    }, 1000)
    return () => clearInterval(timer)
  }, [demoMode, demoId, moving, change])

  const disconnect = async () => {
    manuallyDisconnected.current = true
    if (demoMode) setDemoId(null)
    else if (bridge.current) await bridge.current.disconnect()
    else throw new Error('Bluetooth interface is not ready.')
  }

  const setDemo = async (enabled: boolean) => {
    try {
      if (enabled && physicalActive) {
        if (!bridge.current) throw new Error('Bluetooth interface is not ready.')
        manuallyDisconnected.current = true
        await bridge.current.disconnect()
      }
      setDemoId(null)
      manuallyDisconnected.current = enabled
      change((previous) => ({ ...previous, settings: { ...previous.settings, demoMode: enabled } }))
    } catch (error) { report(error) }
  }

  const openBoards = () => {
    setPanel('boards')
    if (!demoMode && availability.ready && availability.enabled) void scan().catch(report)
  }

  const choose = async (id: string, connect: boolean) => {
    try {
      setDemoId(null)
      change((previous) => ({ ...previous, [domain]: { ...previous[domain], selectedId: id } }))
      if (connect) {
        if (demoMode) {
          if (!change((previous) => ingestTelemetry(previous, 'demo', id, demoTelemetry(id, 0, moving)))) return
          setDemoId(id)
        } else {
          const client = bridge.current
          if (!client) throw new Error('Bluetooth interface is not ready.')
          manuallyDisconnected.current = true
          if (physicalActive) await client.disconnect()
          await client.connect(id)
          manuallyDisconnected.current = false
        }
      }
      setPanel(null)
    } catch (error) { report(error) }
  }

  const timestamp = board?.lastValid?.timestamp
  const lastSeen = timestamp ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'short', timeStyle: 'short' }).format(timestamp) : null
  const connectionLabel = live ? (demoMode ? 'Demo connected' : 'Live BLE') :
    connection.status === 'connecting' && connection.boardId === board?.id && !demoMode ? 'Connecting…' : 'Offline'

  return <>
    <aside className="preview-note">WheelSoul {IS_ANDROID ? 'Android' : 'web'} app <span>·</span> {availability.ready && availability.enabled ? (IS_ANDROID ? 'Live BLE on this phone' : 'Live BLE through this computer') : 'Demo available without a board'}</aside>
    <main className="app-shell">
      <header className="app-header"><div className="brand"><Icon name="wheel" /><h1>{APP_NAME}</h1><span className="app-version" aria-label={`Version ${displayVersion}`}>{displayVersion}</span></div>
        <div className="header-actions"><button className={`demo-toggle ${demoMode ? 'active' : ''}`} aria-label="Demo mode"
          aria-pressed={demoMode} onClick={() => { void setDemo(!demoMode) }}>Demo</button>
          <button className="icon-button" aria-label="Configure dashboard" onClick={() => setPanel('settings')}><Icon name="settings" /></button>
        </div>
      </header>
      {message && <div className="notice error" role="alert"><span>{message}</span><button className="icon-button" aria-label="Dismiss message" onClick={() => setMessage(null)}><Icon name="close" /></button></div>}
      {saveError && <div className="notice error" role="alert"><span>Saving failed: {saveError}. Changes only survive this session.</span>
        <button className="text-button" onClick={() => {
          try { localStorage.setItem(STORAGE_KEY, JSON.stringify(storeRef.current)); savePaused.current = false; setSaveError(null) }
          catch (error) { setSaveError(errorMessage(error)) }
        }}>Retry</button>
      </div>}
      <div className="connection-controls"><button className={`connect-button ${active ? 'disconnect' : ''}`}
        onClick={() => active ? void disconnect().catch(report) : openBoards()}>
        <span className="connection-symbol">{active ? '×' : '+'}</span>{active ? 'Disconnect' : 'Choose board & connect'}
      </button><p className="connection-hint">{demoMode ? 'Configure without a board. Real measurements remain untouched.' : 'Last valid readings are saved separately for each board.'}</p></div>
      {demoMode && <div className="demo-notice"><span className="status-dot" />Demo data · not a real board</div>}
      {!demoMode && !availability.ready && <div className="notice error" role="status">{availability.error ?? (IS_ANDROID ? 'Waiting for the Bluetooth interface…' : 'Waiting for the local BLE server…')}</div>}
      {!demoMode && availability.ready && !availability.enabled && <div className="notice error" role="status">{IS_ANDROID ? (availability.error ?? 'Bluetooth is disabled. Turn it on to scan for boards.') : 'This server was started with --demo-only. Restart without that flag to use BLE.'}</div>}
      <section className="board-heading"><div><button className="board-name" aria-label="Select board" onClick={openBoards}>
        {board?.alias ?? 'No board selected'}{board && boards.favoriteId === board.id && <span className="favorite-label"><Icon name="star" /></span>}<Icon name="chevron" />
      </button><p className={`connection-status ${live ? 'connected' : ''}`}><span className="status-dot" />{connectionLabel}
        {live && !demoMode && <span> · SW {board?.lastValid?.firmware ?? '-'} · HW {board?.lastValid?.hardware ?? '-'}</span>}
        {!live && lastSeen && <span> · Saved {lastSeen}</span>}{!board && <span> · No saved board data yet</span>}</p></div>
        <div className="mode-label"><span>Riding mode</span><strong>{board?.lastValid?.mode ?? '-'}</strong></div>
      </section>
      <section className="primary-grid" aria-label="Primary readings">{store.settings.primary.map((item, i) => <MetricCard key={i} board={board} item={item} primary />)}</section>
      <Gauge speed={board?.lastValid?.speed ?? null} max={board?.maxSpeed ?? null} limit={store.settings.gaugeLimit} live={live} />
      <section className="widgets-section" aria-label="Extra fields">
        {store.settings.widgets.length > 0 && <div className="section-heading"><h2>My dashboard</h2><button className="icon-button" aria-label="Edit extra fields" onClick={() => setPanel('settings')}><Icon name="settings" /></button></div>}
        <div className="widgets-grid">{store.settings.widgets.map((item, i) => <MetricCard key={i} board={board} item={item} />)}</div>
        <button className="add-fields" onClick={() => setPanel('settings')}><Icon name="plus" />{store.settings.widgets.length ? 'Customize dashboard' : 'Add your own readings'}</button>
      </section>
      <footer className="app-footer">Your board. Your dashboard.<span>Telemetry only · no riding mode changes</span></footer>
    </main>

    {panel === 'boards' && <Modal title="Boards" onClose={() => setPanel(null)}>
      <p className="dialog-intro">{demoMode ? 'Two virtual boards. Names, cached readings and maxima stay separate.' : `Turn on your board, close other Onewheel apps, and keep it safely stationary near this ${IS_ANDROID ? 'phone' : 'computer'}.`}</p>
      {message && <div className="notice error">{message}</div>}
      {!demoMode && <button className="add-fields" disabled={scanning || !availability.ready || !availability.enabled} onClick={() => { void scan().catch(report) }}>{scanning ? 'Scanning BLE…' : 'Scan for boards'}</button>}
      <div className="board-list">{boards.boards.map((entry) => {
        const found = visible.find((b) => b.id === entry.id)
        return <article className={`board-entry ${entry.id === board?.id ? 'selected' : ''}`} key={entry.id}>
          <div className="board-entry-top"><button className="board-select" aria-label={`Select ${entry.alias}`} onClick={() => { void choose(entry.id, false) }}>
            <strong>{entry.alias}</strong><span>{entry.advertisedName}{!demoMode && (found ? ` · ${found.rssi} dBm` : ' · saved, not visible')}</span>
          </button><button className={`icon-button favorite ${boards.favoriteId === entry.id ? 'active' : ''}`}
            aria-label={`Favorite ${entry.alias}`} aria-pressed={boards.favoriteId === entry.id}
            onClick={() => change((previous) => ({ ...previous, [domain]: { ...previous[domain], favoriteId: previous[domain].favoriteId === entry.id ? null : entry.id } }))}><Icon name="star" /></button>
            <button className="icon-button" aria-label={`Rename ${entry.alias}`} onClick={() => setRename({ domain, id: entry.id, name: entry.alias })}><Icon name="edit" /></button>
          </div><div className="board-entry-bottom"><span>{formatValue(entry.lastValid?.lifetimeKm ?? null, 1)} km total</span>
            <button className="small-connect" disabled={!demoMode && !found} onClick={() => { void choose(entry.id, true) }}>{demoMode ? 'Connect demo' : 'Connect'}</button>
          </div>
        </article>
      })}</div>
      {!boards.boards.length && <p className="small-note">{scanning ? 'Looking for Onewheel advertisements…' : 'No boards found yet. Check Bluetooth power and permissions, then scan again.'}</p>}
      <div className="info-box"><strong>Favorite & auto-connect</strong><p>A visible favorite connects automatically when Bluetooth is available and this page is in the foreground. Demo mode never connects real hardware.</p>
        <p className="small-note">Manual disconnect pauses auto-connect until an explicit connection or page reload.</p></div>
      <p className="small-note">Names are stored locally. No hard-coded board address and no rename command sent to the board.</p>
    </Modal>}

    {rename && <Modal title="Rename board" onClose={() => setRename(null)}>
      <form onSubmit={(e) => { e.preventDefault(); if (change((previous) => renameBoard(previous, rename.domain, rename.id, rename.name))) setRename(null) }}>
        {message && <div className="notice error">{message}</div>}<label className="rename-label">Your name for this board
          <input autoFocus required maxLength={40} value={rename.name} onChange={(e) => setRename({ ...rename, name: e.target.value })} /></label>
        <p className="small-note">Saved only in WheelSoul. The board's Bluetooth name is not changed.</p><button className="connect-button" type="submit">Save name</button>
      </form>
    </Modal>}

    {panel === 'settings' && <Modal title="Your dashboard" onClose={() => setPanel(null)}>
      <p className="dialog-intro">Choose readings, order and precision. Changes appear immediately and survive a reload.</p>
      <UpdatePanel />
      <h3 className="settings-heading">Primary fields</h3>
      {store.settings.primary.map((item, i) => <FieldEditor key={i} item={item} primary label={`Primary field ${i + 1}`} onChange={(updated) => change((previous) => ({
        ...previous, settings: { ...previous.settings, primary: previous.settings.primary.map((f, n) => n === i ? updated : f) },
      }))} />)}
      <label className="gauge-setting">Speed gauge<select aria-label="Speed scale" value={store.settings.gaugeLimit}
        onChange={(e) => change((previous) => ({ ...previous, settings: { ...previous.settings, gaugeLimit: Number(e.target.value) } }))}>
        {[30, 40, 50, 60].map((n) => <option key={n} value={n}>0 to {n} km/h</option>)}
      </select></label><p className="small-note">Maximum pointer = highest speed recorded for this board. It is not a historical lifetime record read from the board.</p>
      <h3 className="settings-heading">Extra fields</h3>
      {store.settings.widgets.map((item, i) => <div className="widget-editor" key={i}><div className="widget-editor-header"><span>Field {i + 1}</span><div>
        <button className="icon-button" disabled={i === 0} aria-label={`Move field ${i + 1} up`} onClick={() => change((p) => moveWidget(p, i, -1))}><Icon name="up" /></button>
        <button className="icon-button" disabled={i === store.settings.widgets.length - 1} aria-label={`Move field ${i + 1} down`} onClick={() => change((p) => moveWidget(p, i, 1))}><Icon name="down" /></button>
        <button className="icon-button" aria-label={`Remove field ${i + 1}`} onClick={() => change((p) => ({ ...p, settings: { ...p.settings, widgets: p.settings.widgets.filter((_, n) => n !== i) } }))}><Icon name="close" /></button>
      </div></div><FieldEditor item={item} label={`Extra field ${i + 1}`} onChange={(updated) => change((p) => ({
        ...p, settings: { ...p.settings, widgets: p.settings.widgets.map((f, n) => n === i ? updated : f) },
      }))} /></div>)}
      <label className="add-widget-label">Add a reading<select value="" aria-label="Add reading" onChange={(e) => {
        const metric = METRICS.find((m) => m.id === e.target.value)
        if (!metric) { report('Unknown field.'); return }
        change((p) => ({ ...p, settings: { ...p.settings, widgets: [...p.settings.widgets, field(metric.id)] } }))
      }}><option value="" disabled>Choose a reading…</option>{METRICS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</select></label>
      <p className="small-note">Additional BLE fields include raw diagnostics. Raw values have no confirmed physical scale or decoded flag meaning; unavailable readings show -.</p>
      <div className="info-box demo-settings"><strong>Demo mode</strong>
        <label className="switch-row"><span>Try without a real board</span><input type="checkbox" checked={demoMode} onChange={(e) => { void setDemo(e.target.checked) }} /></label>
        <label className="switch-row"><span>Simulate a ride</span><input type="checkbox" checked={moving} disabled={!demoMode} onChange={(e) => setMoving(e.target.checked)} /></label>
        <p className="small-note">Connect a virtual board to animate the gauge. Demo measurements never overwrite real board data.</p>
      </div><button className="text-button reset-layout" onClick={() => change((p) => ({
        ...p, settings: { ...p.settings, primary: createStore().settings.primary, widgets: [], gaugeLimit: 40 },
      }))}>Reset dashboard layout only</button>
    </Modal>}

    {loadError && <Modal title="Saved data cannot be read" onClose={() => {}}>
      <div className="notice error" role="alert">{loadError}</div><p>Your existing local data has not been overwritten.
        Discarding it removes all saved board data and dashboard settings for this {IS_ANDROID ? 'app' : 'browser origin'}.</p>
      <button className="connect-button" onClick={() => location.reload()}>Reload</button><button className="text-button danger" onClick={() => {
        try { localStorage.removeItem(STORAGE_KEY); savePaused.current = false; change(() => createStore()); setLoadError(null); setSaveError(null) }
        catch (error) { report(error) }
      }}>Discard invalid local data</button>
    </Modal>}
  </>
}
