// The human body as signed distance functions (SDF): a smooth, properly proportioned adult figure
// (1.76 m, facing +z, the astronaut's left at +x) and the organ systems inside it. Pure maths with no
// imports, so the same model drives the 3D view (meshed in a worker) and the flat diagram (projected
// by scripts/gen-body-map.ts). Built in code: no external model, so no licence to track.
// Educational shapes and positions, not a medical atlas.

export type Vec3 = readonly [number, number, number]

export interface Shape {
  /** Signed distance (metres): negative inside, positive outside. */
  d: (x: number, y: number, z: number) => number
  lo: Vec3
  hi: Vec3
  /** Bounding sphere, used to skip far parts quickly. */
  c: Vec3
  r: number
}

function bounds(lo: Vec3, hi: Vec3, d: Shape['d']): Shape {
  const c: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]
  const r = Math.hypot(hi[0] - c[0], hi[1] - c[1], hi[2] - c[2])
  return { d, lo, hi, c, r }
}

export function ellipsoid(c: Vec3, r: Vec3): Shape {
  const [cx, cy, cz] = c
  const [rx, ry, rz] = r
  const m = Math.min(rx, ry, rz)
  return bounds([cx - rx, cy - ry, cz - rz], [cx + rx, cy + ry, cz + rz], (x, y, z) => {
    const px = (x - cx) / rx, py = (y - cy) / ry, pz = (z - cz) / rz
    const k0 = Math.sqrt(px * px + py * py + pz * pz)
    const k1 = Math.sqrt((px * px) / (rx * rx) + (py * py) / (ry * ry) + (pz * pz) / (rz * rz))
    return k1 === 0 ? -m : (k0 * (k0 - 1)) / k1
  })
}

/** A tapered capsule from a (radius r1) to b (radius r2). */
export function limb(a: Vec3, b: Vec3, r1: number, r2 = r1): Shape {
  const [ax, ay, az] = a
  const bax = b[0] - ax, bay = b[1] - ay, baz = b[2] - az
  const l2 = bax * bax + bay * bay + baz * baz
  const rr = r1 - r2
  const a2 = l2 - rr * rr
  const il2 = 1 / l2
  const lo: Vec3 = [Math.min(ax - r1, b[0] - r2), Math.min(ay - r1, b[1] - r2), Math.min(az - r1, b[2] - r2)]
  const hi: Vec3 = [Math.max(ax + r1, b[0] + r2), Math.max(ay + r1, b[1] + r2), Math.max(az + r1, b[2] + r2)]
  return bounds(lo, hi, (x, y, z) => {
    const px = x - ax, py = y - ay, pz = z - az
    const t = px * bax + py * bay + pz * baz
    const u = t - l2
    const qx = px * l2 - bax * t, qy = py * l2 - bay * t, qz = pz * l2 - baz * t
    const x2 = qx * qx + qy * qy + qz * qz
    const t2 = t * t * l2
    const u2 = u * u * l2
    const k = Math.sign(rr) * rr * rr * x2
    if (Math.sign(u) * a2 * u2 > k) return Math.sqrt(x2 + u2) * il2 - r2
    if (Math.sign(t) * a2 * t2 < k) return Math.sqrt(x2 + t2) * il2 - r1
    return (Math.sqrt(x2 * a2 * il2) + t * rr) * il2 - r1
  })
}

/** Smooth union: parts melt into each other over about k metres (k = 0: a plain union). */
export function blend(parts: Shape[], k: number): Shape {
  const lo: Vec3 = [Math.min(...parts.map((p) => p.lo[0])) - k / 4, Math.min(...parts.map((p) => p.lo[1])) - k / 4, Math.min(...parts.map((p) => p.lo[2])) - k / 4]
  const hi: Vec3 = [Math.max(...parts.map((p) => p.hi[0])) + k / 4, Math.max(...parts.map((p) => p.hi[1])) + k / 4, Math.max(...parts.map((p) => p.hi[2])) + k / 4]
  return bounds(lo, hi, (x, y, z) => {
    let best = Infinity
    for (const p of parts) {
      // a lower bound on this part's distance; if it cannot change the result, skip it
      const dx = x - p.c[0], dy = y - p.c[1], dz = z - p.c[2]
      const lb = Math.sqrt(dx * dx + dy * dy + dz * dz) - p.r
      if (lb > best + k) continue
      const v = p.d(x, y, z)
      if (best === Infinity || k <= 0) best = Math.min(best, v)
      else {
        const h = Math.max(k - Math.abs(best - v), 0) / k
        best = Math.min(best, v) - h * h * k * 0.25
      }
    }
    return best
  })
}

/** a with b carved out. */
export function carve(a: Shape, b: Shape): Shape {
  return bounds(a.lo, a.hi, (x, y, z) => Math.max(a.d(x, y, z), -b.d(x, y, z)))
}

/** Cut everything below the plane y = floor (flat soles). */
function floor(a: Shape, y0: number): Shape {
  return bounds([a.lo[0], Math.max(a.lo[1], y0), a.lo[2]], a.hi, (x, y, z) => Math.max(a.d(x, y, z), y0 - y))
}

/** The same parts on the astronaut's right (x < 0) and left (x > 0). */
function sides(make: (s: number) => Shape[]): Shape[] {
  return [...make(-1), ...make(1)]
}

// ------------------------------------------------------------------------------------------------
// Key points (one side; s = -1 right, +1 left). Arms hang slightly away from the body (A-pose), so
// the hands stay clear of the hips in the front view.
const SHOULDER = (s: number): Vec3 => [s * 0.185, 1.395, -0.015]
const ELBOW = (s: number): Vec3 => [s * 0.238, 1.115, -0.035]
const WRIST = (s: number): Vec3 => [s * 0.279, 0.865, -0.005]
const KNEE = (s: number): Vec3 => [s * 0.1, 0.5, 0.008]
const ANKLE = (s: number): Vec3 => [s * 0.106, 0.085, -0.02]

const head = blend([
  ellipsoid([0, 1.655, -0.012], [0.077, 0.09, 0.098]), // cranium
  ellipsoid([0, 1.6, 0.028], [0.063, 0.083, 0.07]), // face
  ellipsoid([0, 1.548, 0.034], [0.048, 0.034, 0.05]), // jaw and chin
  limb([0, 1.618, 0.088], [0, 1.588, 0.106], 0.008, 0.012), // nose
  ellipsoid([-0.077, 1.61, -0.006], [0.011, 0.027, 0.017]), // ears
  ellipsoid([0.077, 1.61, -0.006], [0.011, 0.027, 0.017]),
], 0.02)

const neck = limb([0, 1.42, -0.012], [0, 1.565, -0.008], 0.058, 0.05)

const torso = blend([
  ellipsoid([0, 1.39, -0.012], [0.165, 0.058, 0.085]), // shoulder girdle
  ...sides((s) => [limb([0, 1.47, -0.025], [s * 0.165, 1.415, -0.02], 0.045, 0.04)]), // trapezius
  ellipsoid([0, 1.285, -0.006], [0.148, 0.165, 0.103]), // rib cage
  ...sides((s) => [ellipsoid([s * 0.072, 1.305, 0.052], [0.074, 0.058, 0.05])]), // chest muscles
  ellipsoid([0, 1.1, 0.008], [0.124, 0.14, 0.094]), // abdomen
  ellipsoid([0, 0.935, -0.01], [0.152, 0.1, 0.1]), // hips
  ...sides((s) => [ellipsoid([s * 0.074, 0.89, -0.058], [0.079, 0.088, 0.07])]), // buttocks
], 0.045)

const arm = (s: number) => blend([
  ellipsoid([s * 0.19, 1.372, -0.012], [0.05, 0.068, 0.055]), // shoulder (deltoid)
  limb(SHOULDER(s), ELBOW(s), 0.047, 0.035),
  ellipsoid([s * 0.214, 1.25, -0.002], [0.037, 0.072, 0.04]), // biceps
  limb(ELBOW(s), WRIST(s), 0.036, 0.024),
  ellipsoid([s * 0.25, 1.035, -0.018], [0.037, 0.07, 0.037]), // forearm muscles
  ellipsoid([s * 0.284, 0.8, 0.004], [0.021, 0.052, 0.04]), // palm (facing the thigh)
  ellipsoid([s * 0.287, 0.735, 0.012], [0.015, 0.046, 0.034]), // fingers
  limb([s * 0.279, 0.818, 0.034], [s * 0.274, 0.77, 0.055], 0.011, 0.009), // thumb
], 0.022)

const leg = (s: number) => floor(blend([
  limb([s * 0.088, 0.93, 0], KNEE(s), 0.084, 0.047), // thigh
  ellipsoid([s * 0.095, 0.73, 0.022], [0.07, 0.14, 0.06]), // front of the thigh (quadriceps)
  ellipsoid([s * 0.1, 0.5, 0.012], [0.049, 0.05, 0.05]), // knee
  limb(KNEE(s), ANKLE(s), 0.047, 0.029), // lower leg
  ellipsoid([s * 0.105, 0.37, -0.028], [0.049, 0.11, 0.049]), // calf
  limb([s * 0.106, 0.045, -0.04], [s * 0.116, 0.024, 0.135], 0.037, 0.027), // foot, heel to toes
], 0.026), 0)

/** The skin: the whole body. */
export const SKIN: Shape = blend([head, neck, torso, arm(-1), arm(1), leg(-1), leg(1)], 0.018)

// ------------------------------------------------------------------------------------------------
// Organ systems, keyed by the body-system ids the API returns.

// the heart sits in front, between the lungs (which wrap round its sides), apex down and to the left
const heart = blend([
  ellipsoid([0.018, 1.236, 0.04], [0.047, 0.052, 0.042]),
  limb([0.008, 1.268, 0.022], [0.048, 1.195, 0.065], 0.038, 0.017), // base to apex
  limb([0.004, 1.28, 0.012], [0.002, 1.335, -0.004], 0.013), // aorta, rising
  limb([0.002, 1.335, -0.004], [-0.012, 1.31, -0.05], 0.012, 0.011), // aortic arch, back to the spine
], 0.012)

const lung = (s: number): Shape => {
  const body = blend([
    limb([s * 0.058, 1.405, -0.004], [s * 0.074, 1.24, 0.0], 0.026, 0.066),
    ellipsoid([s * 0.075, 1.27, -0.005], [0.061, 0.1, 0.074]),
  ], 0.03)
  // the medial side is flat; the left lung has a notch for the heart
  const medial = ellipsoid([0, 1.29, 0.0], [0.024, 0.2, 0.2])
  const shaped = carve(carve(body, medial), ellipsoid([0, 1.15, 0], [0.2, 0.035, 0.2])) // domed base (diaphragm)
  return s > 0 ? carve(shaped, ellipsoid([0.03, 1.225, 0.06], [0.055, 0.06, 0.06])) : shaped
}

// each hemisphere: frontal, parietal-occipital and temporal lobes; then the cerebellum and brain stem
const hemisphere = (s: number) => blend([
  ellipsoid([s * 0.03, 1.685, 0.028], [0.031, 0.037, 0.042]),
  ellipsoid([s * 0.031, 1.684, -0.036], [0.032, 0.039, 0.048]),
  ellipsoid([s * 0.043, 1.643, -0.002], [0.02, 0.021, 0.043]),
], 0.018)
const brain = blend([
  hemisphere(-1),
  hemisphere(1),
  ellipsoid([0, 1.622, -0.066], [0.04, 0.019, 0.026]), // cerebellum
  limb([0, 1.64, -0.03], [0, 1.565, -0.038], 0.012, 0.01), // brain stem
], 0.006)

const eyes = blend(sides((s) => [ellipsoid([s * 0.032, 1.62, 0.067], [0.0125, 0.0125, 0.0125])]), 0)

const smallBowel: Shape[] = []
for (let i = 0; i < 3; i++) {
  for (let j = 0; j < 3; j++) {
    smallBowel.push(ellipsoid([-0.048 + 0.048 * j + (i % 2) * 0.012, 0.95 + 0.033 * i, 0.04 - 0.004 * j], [0.027, 0.02, 0.026]))
  }
}
const digestive = blend([
  ellipsoid([-0.058, 1.148, 0.02], [0.088, 0.048, 0.066]), // liver (right side)
  limb([0.062, 1.16, 0.022], [0.035, 1.1, 0.042], 0.04, 0.034), // stomach
  limb([0.035, 1.1, 0.042], [-0.012, 1.093, 0.046], 0.034, 0.02),
  limb([-0.078, 0.92, 0.028], [-0.08, 1.058, 0.03], 0.022), // large intestine: up the right side,
  limb([-0.08, 1.058, 0.03], [0.08, 1.058, 0.035], 0.021), // across,
  limb([0.08, 1.058, 0.035], [0.074, 0.915, 0.028], 0.021), // and down the left
  ...smallBowel,
], 0.012)

const immune = blend([
  ...sides((s) => [
    ellipsoid([s * 0.038, 1.47, 0.016], [0.01, 0.012, 0.01]), // lymph nodes in the neck
    ellipsoid([s * 0.155, 1.305, -0.012], [0.013, 0.015, 0.013]), // armpits
    ellipsoid([s * 0.082, 0.9, 0.06], [0.012, 0.01, 0.01]), // groin
  ]),
  ellipsoid([0.098, 1.138, -0.045], [0.02, 0.044, 0.03]), // spleen
  ellipsoid([0, 1.372, 0.05], [0.022, 0.03, 0.012]), // thymus
], 0)

const muscles = blend(sides((s) => [
  ellipsoid([s * 0.192, 1.372, -0.01], [0.044, 0.062, 0.049]), // deltoid
  ellipsoid([s * 0.214, 1.25, 0.0], [0.031, 0.066, 0.034]), // biceps
  ellipsoid([s * 0.25, 1.035, -0.014], [0.031, 0.064, 0.031]), // forearm
  ellipsoid([s * 0.097, 0.73, 0.027], [0.062, 0.13, 0.052]), // quadriceps
  ellipsoid([s * 0.105, 0.37, -0.032], [0.043, 0.1, 0.043]), // calf
]), 0)

const vertebrae: Shape[] = []
for (let i = 0; i <= 22; i++) {
  const t = i / 22 // 0 = lower back, 1 = neck
  const y = 0.98 + t * 0.53
  const z = -0.045 - 0.032 * Math.sin(Math.PI * t) // gentle curve of the spine
  vertebrae.push(ellipsoid([0, y, z], [0.017 - 0.006 * t, 0.009, 0.016 - 0.004 * t]))
}
const bones = blend([
  ...vertebrae,
  ...sides((s) => [
    limb([s * 0.016, 1.43, 0.035], [s * 0.168, 1.432, -0.002], 0.009, 0.008), // collarbone
    ellipsoid([s * 0.083, 0.97, -0.022], [0.052, 0.045, 0.024]), // pelvis (hip bone)
    ellipsoid([s * 0.076, 0.885, 0], [0.02, 0.02, 0.02]), // hip joint
    limb([s * 0.08, 0.875, 0], [s * 0.099, 0.53, 0.004], 0.015, 0.014), // thigh bone (femur)
    ellipsoid([s * 0.1, 0.505, 0.004], [0.026, 0.02, 0.024]), // knee joint
    ellipsoid([s * 0.1, 0.5, 0.046], [0.017, 0.02, 0.009]), // kneecap
    limb([s * 0.1, 0.48, 0.006], [s * 0.106, 0.095, -0.012], 0.016, 0.012), // shin bone (tibia)
    limb(SHOULDER(s), ELBOW(s), 0.013, 0.011), // upper arm bone
    limb(ELBOW(s), WRIST(s), 0.01, 0.009), // forearm bones
  ]),
  ellipsoid([0, 0.93, -0.055], [0.035, 0.045, 0.02]), // sacrum
], 0.006)

export const ORGANS: Record<string, Shape> = {
  bones,
  muscles,
  lungs: blend([lung(-1), lung(1)], 0),
  heart,
  digestive,
  immune,
  brain,
  eyes,
}

/** Back to front: what lies deeper is drawn first, so the front-most part is the one you click. */
export const DRAW_ORDER = ['bones', 'muscles', 'lungs', 'heart', 'digestive', 'immune', 'brain', 'eyes'] as const

/** Where the 3D camera looks for each system, and how close it comes (metres). */
export const FOCUS: Record<string, { target: Vec3; distance: number }> = {
  brain: { target: [0, 1.64, 0], distance: 1.0 },
  eyes: { target: [0, 1.62, 0.05], distance: 0.8 },
  heart: { target: [0.02, 1.24, 0.04], distance: 1.3 },
  lungs: { target: [0, 1.28, 0], distance: 1.5 },
  digestive: { target: [0, 1.05, 0.03], distance: 1.6 },
  immune: { target: [0, 1.2, 0], distance: 2.2 },
  muscles: { target: [0, 0.95, 0], distance: 3.2 },
  bones: { target: [0, 0.95, 0], distance: 3.2 },
  whole_body: { target: [0, 0.92, 0], distance: 3.4 },
}
