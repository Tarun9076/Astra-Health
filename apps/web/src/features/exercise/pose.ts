// Body points from MediaPipe Pose (33 landmarks) and the geometry the coach needs.
// Landmarks arrive normalised to the image (x of the width, y of the height, y down). Angles are only
// right in square units, so `toBody` scales x by the image's aspect ratio first.

export interface Landmark {
  x: number
  y: number
  z?: number
  visibility?: number
}

/** 33 landmarks in body units (x scaled by width / height). */
export type Pose = Landmark[]

export const P = {
  nose: 0,
  leftShoulder: 11, rightShoulder: 12,
  leftElbow: 13, rightElbow: 14,
  leftWrist: 15, rightWrist: 16,
  leftHip: 23, rightHip: 24,
  leftKnee: 25, rightKnee: 26,
  leftAnkle: 27, rightAnkle: 28,
  leftHeel: 29, rightHeel: 30,
  leftToe: 31, rightToe: 32,
} as const

/** Lines drawn between body points (MediaPipe's pose connections, without the face and fingers). */
export const BONES: [number, number][] = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [27, 29], [29, 31], [27, 31], [24, 26], [26, 28], [28, 30], [30, 32], [28, 32],
]

export interface Side {
  shoulder: number
  elbow: number
  wrist: number
  hip: number
  knee: number
  ankle: number
  heel: number
  toe: number
}

const LEFT: Side = { shoulder: 11, elbow: 13, wrist: 15, hip: 23, knee: 25, ankle: 27, heel: 29, toe: 31 }
const RIGHT: Side = { shoulder: 12, elbow: 14, wrist: 16, hip: 24, knee: 26, ankle: 28, heel: 30, toe: 32 }

export function toBody(landmarks: Landmark[], aspect: number): Pose {
  return landmarks.map((l) => ({ x: l.x * aspect, y: l.y, z: l.z, visibility: l.visibility ?? 1 }))
}

/** Angle at b between a and c, in degrees (0-180). */
export function angle(a: Landmark, b: Landmark, c: Landmark): number {
  const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y
  const n = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y)
  if (n === 0) return 180
  return (Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / n))) * 180) / Math.PI
}

export function dist(a: Landmark, b: Landmark): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function mid(a: Landmark, b: Landmark): Landmark {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, visibility: Math.min(a.visibility ?? 1, b.visibility ?? 1) }
}

/** Lean of the line from `low` up to `high`, from vertical, in degrees (0 = upright). */
export function leanFromVertical(low: Landmark, high: Landmark): number {
  return (Math.atan2(Math.abs(high.x - low.x), Math.max(1e-9, low.y - high.y)) * 180) / Math.PI
}

const vis = (p: Landmark | undefined) => p?.visibility ?? 0

/** The side of the body the camera sees best (in a side view, the far side is hidden). */
export function bestSide(pose: Pose): Side {
  const score = (s: Side) => [s.shoulder, s.hip, s.knee, s.ankle].reduce((sum, i) => sum + vis(pose[i]), 0)
  return score(RIGHT) >= score(LEFT) ? RIGHT : LEFT
}

/** True when these points of the given side are confidently seen and inside the picture. */
export function visible(pose: Pose | null, side: Side, keys: (keyof Side)[], aspect = 1): boolean {
  if (!pose || pose.length < 33) return false
  return keys.every((k) => {
    const p = pose[side[k]]
    return vis(p) >= 0.5 && p.y > -0.03 && p.y < 1.03 && p.x > -0.03 * aspect && p.x < 1.03 * aspect
  })
}

export function torsoLength(pose: Pose): number {
  return dist(mid(pose[11], pose[12]), mid(pose[23], pose[24]))
}

/** Facing the camera (shoulders wide in the picture) rather than side-on. */
export function facingCamera(pose: Pose): boolean {
  return Math.abs(pose[11].x - pose[12].x) > 0.35 * torsoLength(pose)
}
