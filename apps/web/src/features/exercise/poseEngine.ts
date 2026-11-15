// Loads MediaPipe Pose Landmarker (Apache-2.0) once, from files the app serves itself, so body
// tracking works offline and no image ever leaves the device: the engine from /mediapipe/wasm/
// (copied from node_modules by vite.config.ts) and the model from /models/ (public/models).
import type { PoseLandmarker } from '@mediapipe/tasks-vision'

export const MODEL_URL = '/models/pose_landmarker_full.task'
const WASM_URL = '/mediapipe/wasm'

let loading: Promise<PoseLandmarker> | null = null

export function loadPoseLandmarker(): Promise<PoseLandmarker> {
  loading ??= (async () => {
    const { FilesetResolver, PoseLandmarker } = await import('@mediapipe/tasks-vision')
    const files = await FilesetResolver.forVisionTasks(WASM_URL)
    const make = (delegate: 'GPU' | 'CPU') =>
      PoseLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5,
      })
    try {
      return await make('GPU')
    } catch {
      return await make('CPU') // no WebGL: slower, still works
    }
  })()
  loading.catch(() => {
    loading = null // let the next attempt try again
  })
  return loading
}

/** A readable reason why the camera could not start. */
export function cameraError(e: unknown, stage: 'camera' | 'tracking'): string {
  if (typeof window !== 'undefined' && !window.isSecureContext) return 'The camera only works over https or on localhost.'
  const name = e instanceof DOMException || e instanceof Error ? e.name : ''
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera permission was refused. Allow the camera in the browser’s address bar and try again, or use demo playback.'
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found on this device.'
    case 'NotSupportedError':
      return 'This browser cannot open a camera here. Try Chrome or Edge, or use demo playback.'
    case 'NotReadableError':
    case 'AbortError':
      return 'The camera is in use by another app. Close it and try again.'
    default:
      return `${stage === 'camera' ? 'The camera' : 'Body tracking'} could not start${e instanceof Error && e.message ? `: ${e.message}` : '.'}`
  }
}
