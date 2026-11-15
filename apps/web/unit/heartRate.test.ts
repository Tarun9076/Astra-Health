// Bluetooth heart-rate parsing (Step 15: T-W-01). Byte layouts from the Bluetooth Heart Rate Service spec.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { median, parseHeartRate, usable } from '../src/lib/heartRate.ts'

const view = (...bytes: number[]) => new DataView(new Uint8Array(bytes).buffer)

test('8-bit heart rate, no extras (the most common watch format)', () => {
  assert.deepEqual(parseHeartRate(view(0x00, 72)), { bpm: 72, contact: null, rr: [] })
})

test('16-bit heart rate', () => {
  assert.equal(parseHeartRate(view(0x01, 0x2c, 0x01))?.bpm, 300) // 0x012C, little-endian
})

test('skin contact reported: present and missing', () => {
  assert.equal(parseHeartRate(view(0x06, 80))?.contact, true) // bits 1 + 2
  assert.equal(parseHeartRate(view(0x04, 80))?.contact, false) // supported, not in contact
  assert.equal(usable(parseHeartRate(view(0x04, 80))), false) // a watch off the wrist is ignored
})

test('energy field skipped, RR intervals read in milliseconds', () => {
  // flags: energy (0x08) + RR (0x10); bpm 60; energy 0x0010; RR 1024/1024 s = 1000 ms, 512 = 500 ms
  const s = parseHeartRate(view(0x18, 60, 0x10, 0x00, 0x00, 0x04, 0x00, 0x02))
  assert.deepEqual(s, { bpm: 60, contact: null, rr: [1000, 500] })
})

test('too short or impossible values are not used', () => {
  assert.equal(parseHeartRate(view(0x00)), null)
  assert.equal(parseHeartRate(view(0x01, 0x40)), null) // 16-bit flag but only one byte
  assert.equal(usable(parseHeartRate(view(0x00, 0))), false) // 0 bpm: no reading yet
  assert.equal(usable(parseHeartRate(view(0x00, 255))), false)
})

test('median ignores a single wrong beat', () => {
  assert.equal(median([62, 63, 61, 140, 62]), 62)
  assert.equal(median([60, 64]), 62)
  assert.equal(median([]), null)
})
