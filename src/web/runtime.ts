import { Capacitor } from '@capacitor/core'
import { Bridge } from './bridge'
import type { Availability, Connection, SampleEvent, Transport } from './bridge'

export const IS_ANDROID = Capacitor.getPlatform() === 'android'

export async function createTransport(
  onEvent: (event: Connection | SampleEvent) => void,
  onAvailability: (availability: Availability) => void,
  onError: (message: string) => void,
  onForeground: (visible: boolean) => void,
): Promise<Transport> {
  if (IS_ANDROID) {
    const { AndroidBridge } = await import('../../src_android/native/bridge')
    return new AndroidBridge(onEvent, onAvailability, onError, onForeground)
  }
  return new Bridge(onEvent, onAvailability, onError)
}
