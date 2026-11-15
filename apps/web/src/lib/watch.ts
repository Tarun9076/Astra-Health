// The astronaut's own smartwatch, connected over Bluetooth from the browser (Step 15). Any watch or
// chest strap with the standard Heart Rate service works (tested design: Fire-Boltt BGR002). Chrome
// and Edge only; the page must be on localhost or https.
//
// - Live heart rate for the header, the check-in and the exercise coach.
// - While connected, one `heart_rate` reading a minute (the median of that minute) is saved as a
//   Wearable reading through the normal intake, so it gets the personal normal, rules and Earth sync.
// - "Measure with my watch": the median of 30 s at rest, for the check-in's resting heart rate.
import { create } from 'zustand'
import { median, parseHeartRate, usable } from './heartRate'

export type WatchStatus = 'off' | 'connecting' | 'on' | 'reconnecting' | 'error'

interface WatchState {
  status: WatchStatus
  name: string | null
  bpm: number | null
  at: number | null // time of the last beat reading (ms)
  message: string | null // why it is not connected, in plain words
  savedMinutes: number
}

export const useWatch = create<WatchState>(() => ({
  status: 'off', name: null, bpm: null, at: null, message: null, savedMinutes: 0,
}))

const SAMPLE_KEEP_MS = 5 * 60_000
let samples: { t: number; bpm: number }[] = []
let device: BluetoothDevice | null = null
let characteristic: BluetoothRemoteGATTCharacteristic | null = null
let wanted = false // the user wants it connected (reconnect after a drop)

export const watchSupported = () => typeof navigator !== 'undefined' && Boolean(navigator.bluetooth)

function onValue(event: Event) {
  const value = (event.target as BluetoothRemoteGATTCharacteristic).value
  const sample = value ? parseHeartRate(value) : null
  if (!usable(sample)) return
  const t = Date.now()
  samples.push({ t, bpm: sample.bpm })
  samples = samples.filter((s) => t - s.t < SAMPLE_KEEP_MS)
  useWatch.setState({ bpm: sample.bpm, at: t })
}

async function subscribe(d: BluetoothDevice) {
  const server = await d.gatt!.connect()
  const service = await server.getPrimaryService('heart_rate')
  characteristic = await service.getCharacteristic('heart_rate_measurement')
  characteristic.addEventListener('characteristicvaluechanged', onValue)
  await characteristic.startNotifications()
}

function explain(e: unknown): string | null {
  const name = e instanceof DOMException || e instanceof Error ? e.name : ''
  const text = e instanceof Error ? e.message : ''
  if (name === 'NotFoundError' && /cancel/i.test(text)) return null // chooser closed: not an error
  if (name === 'NotFoundError' && /service/i.test(text)) return 'This device has no heart-rate signal. Choose your watch, not another Bluetooth device.'
  if (name === 'NotFoundError') return null
  if (name === 'SecurityError') return 'Bluetooth is blocked here. Use Chrome or Edge on localhost or https.'
  if (name === 'NetworkError' || /GATT|connect/i.test(text)) {
    return 'Could not connect. Turn off Bluetooth on your phone for a moment (the watch talks to one device at a time), then try again.'
  }
  return `Could not connect to the watch${text ? `: ${text}` : '.'}`
}

async function onDisconnected() {
  characteristic = null
  if (!wanted || !device) {
    useWatch.setState({ status: 'off' })
    return
  }
  useWatch.setState({ status: 'reconnecting' })
  for (const wait of [1000, 3000, 8000]) {
    await new Promise((r) => setTimeout(r, wait))
    if (!wanted || !device) return
    try {
      await subscribe(device)
      useWatch.setState({ status: 'on', message: null })
      return
    } catch {
      /* try again */
    }
  }
  wanted = false
  useWatch.setState({ status: 'error', message: 'The watch disconnected. Bring it closer and connect again.' })
}

/** Opens the browser's device chooser (needs a click), then follows the heart rate. */
export async function connectWatch(): Promise<void> {
  if (!watchSupported()) {
    useWatch.setState({ status: 'error', message: 'This browser cannot use Bluetooth. Use Chrome or Edge on a computer with Bluetooth.' })
    return
  }
  useWatch.setState({ status: 'connecting', message: null })
  try {
    // Many watches do not announce the heart-rate service before connecting, so list every device
    // and ask for the service after; the person picks their watch by name.
    const d = await navigator.bluetooth!.requestDevice({ acceptAllDevices: true, optionalServices: ['heart_rate', 'battery_service'] })
    device = d
    d.addEventListener('gattserverdisconnected', () => void onDisconnected())
    await subscribe(d)
    wanted = true
    samples = []
    useWatch.setState({ status: 'on', name: d.name ?? 'Your watch', message: null, bpm: null, at: null })
  } catch (e) {
    wanted = false
    if (device?.gatt?.connected) device.gatt.disconnect()
    useWatch.setState({ status: explain(e) ? 'error' : 'off', message: explain(e) })
  }
}

export function disconnectWatch(): void {
  wanted = false
  characteristic?.removeEventListener('characteristicvaluechanged', onValue)
  if (device?.gatt?.connected) device.gatt.disconnect()
  device = null
  samples = []
  useWatch.setState({ status: 'off', bpm: null, at: null, message: null })
}

/** Median heart rate of the samples since `since` (ms). */
export function medianSince(since: number): { bpm: number | null; count: number } {
  const recent = samples.filter((s) => s.t >= since).map((s) => s.bpm)
  return { bpm: median(recent), count: recent.length }
}

/** Is the reading fresh? Watches send about once a second; older than 10 s means no live signal. */
export function liveBpm(s: Pick<WatchState, 'status' | 'bpm' | 'at'>, now = Date.now()): number | null {
  return s.status === 'on' && s.bpm != null && s.at != null && now - s.at < 10_000 ? s.bpm : null
}
