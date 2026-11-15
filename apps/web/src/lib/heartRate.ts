// Bluetooth "Heart Rate Measurement" (characteristic 0x2A37 of the standard Heart Rate service 0x180D),
// as sent by watches and chest straps. Pure, so it is tested without a device (unit/heartRate.test.ts).
//
// Byte 0 is a set of flags:
//   bit 0  heart rate is 16-bit (else 8-bit)
//   bit 1  skin contact detected   (only meaningful when bit 2 is set)
//   bit 2  skin contact is reported
//   bit 3  energy expended field present (2 bytes, skipped)
//   bit 4  RR intervals present (2 bytes each, in 1/1024 s)

export interface HeartRateSample {
  bpm: number
  contact: boolean | null // null: the watch does not report skin contact
  rr: number[] // beat-to-beat intervals in milliseconds (may be empty)
}

export function parseHeartRate(view: DataView): HeartRateSample | null {
  if (view.byteLength < 2) return null
  const flags = view.getUint8(0)
  const wide = (flags & 0x01) !== 0
  if (wide && view.byteLength < 3) return null
  const bpm = wide ? view.getUint16(1, true) : view.getUint8(1)
  let offset = wide ? 3 : 2
  const contact = (flags & 0x04) !== 0 ? (flags & 0x02) !== 0 : null
  if ((flags & 0x08) !== 0) offset += 2
  const rr: number[] = []
  if ((flags & 0x10) !== 0) {
    for (; offset + 1 < view.byteLength; offset += 2) rr.push(Math.round((view.getUint16(offset, true) / 1024) * 1000))
  }
  return { bpm, contact, rr }
}

/** A reading worth keeping: a real beat rate, and skin contact if the watch reports it. */
export function usable(s: HeartRateSample | null): s is HeartRateSample {
  return s != null && s.bpm >= 25 && s.bpm <= 250 && s.contact !== false
}

/** Median: steady against single wrong beats. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}
