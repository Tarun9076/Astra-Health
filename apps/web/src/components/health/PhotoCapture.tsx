import { Camera, ImagePlus, Trash2, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { PhotoIn } from '../../lib/api'
import { Button } from '../ui/Panel'

export type PhotoKind = PhotoIn['kind']
export type DraftPhoto = { id: string; kind: PhotoKind; note: string; dataUrl: string; takenAt: string }

const KINDS: { value: PhotoKind; label: string; hint: string }[] = [
  { value: 'Skin', label: 'Skin', hint: 'rash, redness, swelling' },
  { value: 'Eye', label: 'Eye', hint: 'redness, irritation' },
  { value: 'Wound', label: 'Wound or injury', hint: 'cut, bruise, burn' },
  { value: 'DeviceReading', label: 'Device reading', hint: 'the display of a meter or monitor' },
  { value: 'Other', label: 'Other', hint: '' },
]
const MAX_SIDE = 1280
const MAX_PHOTOS = 3

/** Shrink to at most 1280 px and re-encode as JPEG, so a photo is a few hundred kB (fits the link). */
async function toJpeg(source: CanvasImageSource, width: number, height: number): Promise<string> {
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(width * scale)
  canvas.height = Math.round(height * scale)
  canvas.getContext('2d')?.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.82)
}

async function fileToJpeg(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file)
  try {
    return await toJpeg(bitmap, bitmap.width, bitmap.height)
  } finally {
    bitmap.close()
  }
}

/** Optional photos for the flight surgeon. The app does not analyse them; a doctor looks at them. */
export function PhotoCapture({ photos, onChange }: { photos: DraftPhoto[]; onChange: (p: DraftPhoto[]) => void }) {
  const [kind, setKind] = useState<PhotoKind>('Skin')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [cameraOpen, setCameraOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const ids = useId()
  const hasCamera = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia)
  const full = photos.length >= MAX_PHOTOS

  const add = (dataUrl: string) => {
    onChange([...photos, { id: crypto.randomUUID(), kind, note: note.trim(), dataUrl, takenAt: new Date().toISOString() }])
    setNote('')
    setError(null)
  }
  const onFile = async (file: File | undefined) => {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setError('Choose a photo (JPEG, PNG or similar).')
      return
    }
    try {
      add(await fileToJpeg(file))
    } catch {
      setError('This photo could not be read. Try another one.')
    }
    if (fileRef.current) fileRef.current.value = ''
  }

  return (
    <section aria-labelledby={`${ids}-h`} className="space-y-3 rounded-lg border border-line p-4">
      <div>
        <h3 id={`${ids}-h`} className="font-semibold">Add a photo <span className="font-normal text-ink-muted">(optional)</span></h3>
        <p className="text-sm text-ink-muted">
          A photo helps the flight surgeon see a rash, a red eye, a wound or a device’s display. It goes to your health
          record and to the flight surgeon. The app does not analyse it.
        </p>
      </div>
      {!full && (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="font-medium">What does it show?</span>
            <select value={kind} onChange={(e) => setKind(e.target.value as PhotoKind)}
              className="mt-1 block min-h-11 w-full rounded-lg border border-line-strong bg-surface px-3">
              {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}{k.hint && ` — ${k.hint}`}</option>)}
            </select>
          </label>
          <label className="block text-sm">
            <span className="font-medium">Short note</span> <span className="text-ink-muted">(optional)</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="e.g. left forearm, itchy since yesterday"
              className="mt-1 block min-h-11 w-full rounded-lg border border-line-strong bg-surface px-3" />
          </label>
        </div>
      )}
      {!full && (
        <div className="flex flex-wrap gap-2">
          {hasCamera && (
            <Button variant="ghost" onClick={() => setCameraOpen(true)}>
              <Camera className="h-4 w-4" aria-hidden /> Use the camera
            </Button>
          )}
          <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-line-strong px-4 text-sm font-medium hover:bg-subtle focus-within:outline-2 focus-within:outline-accent">
            <ImagePlus className="h-4 w-4" aria-hidden /> Choose a photo
            {/* on a tablet or phone, `capture` opens the camera directly */}
            <input ref={fileRef} type="file" accept="image/*" capture="environment" className="sr-only"
              onChange={(e) => void onFile(e.target.files?.[0])} />
          </label>
        </div>
      )}
      {full && <p className="text-sm text-ink-muted">You can add up to {MAX_PHOTOS} photos per check-in.</p>}
      {error && <p role="alert" className="text-sm text-status-red">{error}</p>}
      {cameraOpen && <CameraDialog onCapture={(d) => { add(d); setCameraOpen(false) }} onClose={() => setCameraOpen(false)} />}
      {photos.length > 0 && (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3" aria-label="Photos to send">
          {photos.map((p, i) => (
            <li key={p.id} className="overflow-hidden rounded-lg border border-line">
              <img src={p.dataUrl} alt={`Photo ${i + 1}: ${KINDS.find((k) => k.value === p.kind)?.label}${p.note ? `, ${p.note}` : ''}`}
                className="aspect-square w-full object-cover" />
              <div className="flex items-center justify-between gap-2 p-2 text-xs">
                <span className="truncate">{KINDS.find((k) => k.value === p.kind)?.label}</span>
                <button type="button" onClick={() => onChange(photos.filter((x) => x.id !== p.id))}
                  className="inline-flex min-h-9 items-center gap-1 rounded px-2 font-medium text-status-red hover:bg-status-red/5">
                  <Trash2 className="h-3.5 w-3.5" aria-hidden /> Remove<span className="sr-only"> photo {i + 1}</span>
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** Live camera (laptop or tablet webcam): preview, then take the photo. */
function CameraDialog({ onCapture, onClose }: { onCapture: (dataUrl: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let stream: MediaStream | null = null
    let cancelled = false
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop())
          return
        }
        stream = s
        if (video.current) {
          video.current.srcObject = s
          void video.current.play().then(() => setReady(true)).catch(() => setReady(true))
        }
      })
      .catch(() => setError('The camera is not available. Allow camera access, or choose a photo instead.'))
    return () => {
      cancelled = true
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  const take = async () => {
    const v = video.current
    if (!v || !v.videoWidth) return
    onCapture(await toJpeg(v, v.videoWidth, v.videoHeight))
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Camera" className="space-y-3 rounded-lg border border-accent/40 bg-canvas p-3">
      {error ? <p role="alert" className="text-sm text-status-red">{error}</p> : (
        <video ref={video} muted playsInline className="max-h-80 w-full rounded-lg bg-ink object-contain" aria-label="Camera preview" />
      )}
      <div className="flex flex-wrap gap-2">
        {!error && (
          <Button onClick={() => void take()} disabled={!ready}>
            <Camera className="h-4 w-4" aria-hidden /> Take photo
          </Button>
        )}
        <Button variant="ghost" onClick={onClose}>
          <X className="h-4 w-4" aria-hidden /> Cancel
        </Button>
      </div>
    </div>
  )
}
