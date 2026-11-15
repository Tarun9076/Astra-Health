// Interactive 3D body: a see-through human figure with the organ systems inside, each coloured by
// its status. Built in code from the anatomy model (anatomy.ts), meshed in a worker. Drag to turn,
// scroll to zoom, click a system to open it; choosing a system moves the camera to it.
import { ContactShadows, OrbitControls } from '@react-three/drei'
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { use, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import type { BodyRegion } from '../../lib/queries'
import { DRAW_ORDER, FOCUS, type Vec3 } from './anatomy'
import type { BodyMeshes } from './bodyMesh.worker'
import { STATUS_FILL, STATUS_LABEL, statusOf, SYSTEM_INFO } from './regions'

let meshes: Promise<BodyMeshes | null> | null = null
function loadMeshes() {
  meshes ??= new Promise((resolve) => {
    const worker = new Worker(new URL('./bodyMesh.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<BodyMeshes>) => { resolve(e.data); worker.terminate() }
    worker.onerror = () => { meshes = null; resolve(null); worker.terminate() }
  })
  return meshes
}

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

// See-through skin: faint in the middle, brighter at the edges (a Fresnel rim), lit from the front.
const SKIN_VERTEX = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`
const SKIN_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uGlow;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vec3 n = normalize(vNormal);
    vec3 v = normalize(vView);
    vec3 l = normalize(vec3(0.35, 0.65, 1.0));
    float rim = pow(1.0 - abs(dot(n, v)), 2.2);
    float diffuse = 0.5 + 0.5 * max(dot(n, l), 0.0);
    float spec = pow(max(dot(n, normalize(l + v)), 0.0), 40.0) * 0.18;
    float alpha = 0.26 + rim * (0.55 + 0.3 * uGlow);
    gl_FragColor = vec4(uColor * diffuse + spec + rim * 0.12, alpha);
  }`

function geometryOf(m: BodyMeshes[string]) {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3))
  g.setIndex(new THREE.BufferAttribute(m.indices, 1))
  g.computeBoundingSphere()
  return g
}

function Skin({ geometry, colour, glow, visible }: { geometry: THREE.BufferGeometry; colour: string; glow: number; visible: boolean }) {
  const ref = useRef<THREE.ShaderMaterial>(null)
  const uniforms = useMemo(() => ({ uColor: { value: new THREE.Color() }, uGlow: { value: 0 } }), [])
  useFrame(() => {
    const m = ref.current
    if (!m) return
    m.uniforms.uColor.value.set(colour)
    m.uniforms.uGlow.value = glow
  })
  return (
    <mesh geometry={geometry} visible={visible} userData={{ region: 'whole_body' }} renderOrder={2}>
      <shaderMaterial ref={ref} vertexShader={SKIN_VERTEX} fragmentShader={SKIN_FRAGMENT} uniforms={uniforms} transparent depthWrite={false} />
    </mesh>
  )
}

function Organ({ id, geometry, colour, selected, hovered, solid }: {
  id: string
  geometry: THREE.BufferGeometry
  colour: string
  selected: boolean
  hovered: boolean
  /** Drawn solid (chosen, pointed at, or not within normal); otherwise a faint ghost inside the skin.
   *  Always `transparent` (changing that flag needs a shader rebuild); only opacity and depth writes change. */
  solid: boolean
}) {
  const ref = useRef<THREE.MeshStandardMaterial>(null)
  const still = useMemo(() => reducedMotion(), [])
  useFrame(({ clock }) => {
    if (!ref.current) return
    const pulse = selected && !still ? 0.32 + 0.2 * Math.sin(clock.elapsedTime * 3) : 0.38
    ref.current.emissiveIntensity = selected ? pulse : hovered ? 0.4 : 0.08
  })
  return (
    <mesh geometry={geometry} userData={{ region: id }} renderOrder={solid ? 0 : 1}>
      <meshStandardMaterial ref={ref} color={colour} emissive={colour} roughness={0.42} metalness={0.05}
        transparent opacity={solid ? 1 : 0.16} depthWrite={solid} />
    </mesh>
  )
}

const SKIN_TONE = '#c9a58c'

type Goal = { target: THREE.Vector3; position: THREE.Vector3 }

const FRONT = new THREE.Vector3(0.3, 0.12, 1).normalize()
const VIEWS = {
  front: new THREE.Vector3(0, 0.08, 1).normalize(),
  side: new THREE.Vector3(1, 0.08, 0).normalize(),
  back: new THREE.Vector3(0, 0.08, -1).normalize(),
} as const
type View = keyof typeof VIEWS

function goalFor(region: string, direction = FRONT): Goal {
  const f = FOCUS[region] ?? FOCUS.whole_body
  const target = new THREE.Vector3(...(f.target as Vec3))
  return { target, position: target.clone().addScaledVector(direction, f.distance) }
}

/** Moves the camera smoothly to the goal; any drag or zoom by the user takes over at once. */
function CameraRig({ goal, onUserMove }: { goal: Goal | null; onUserMove: () => void }) {
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null
  const active = useRef<Goal | null>(null)
  const still = useMemo(() => reducedMotion(), [])
  useEffect(() => { active.current = goal }, [goal])
  useEffect(() => {
    if (!controls) return
    const stop = () => { active.current = null; onUserMove() }
    controls.addEventListener('start', stop)
    return () => controls.removeEventListener('start', stop)
  }, [controls, onUserMove])
  useFrame((_, dt) => {
    const g = active.current
    if (!g || !controls) return
    const k = still ? 1 : 1 - Math.exp(-dt * 4)
    controls.target.lerp(g.target, k)
    camera.position.lerp(g.position, k)
    controls.update()
    if (camera.position.distanceTo(g.position) < 0.004 && controls.target.distanceTo(g.target) < 0.004) active.current = null
  })
  return null
}

export default function BodyModel3D({ regions, selected, onSelect }: {
  regions: BodyRegion[] | undefined
  selected: string
  onSelect: (id: string) => void
}) {
  const data = use(loadMeshes())
  const geometries = useMemo(() => (data ? Object.fromEntries(Object.entries(data).map(([id, m]) => [id, geometryOf(m)])) : null), [data])
  useEffect(() => () => { Object.values(geometries ?? {}).forEach((g) => g.dispose()) }, [geometries])

  const [hovered, setHovered] = useState<string | null>(null)
  const [turning, setTurning] = useState(() => !reducedMotion())
  const [skin, setSkin] = useState(true)
  const [goal, setGoal] = useState<Goal | null>(null)
  const shown = useRef(selected) // open on the whole body; move only when the choice changes
  useEffect(() => {
    if (shown.current === selected) return
    shown.current = selected
    setGoal(goalFor(selected))
  }, [selected])
  const show = (view: View) => setGoal(goalFor('whole_body', VIEWS[view]))
  const stopTurning = useMemo(() => () => setTurning(false), [])

  if (!geometries) {
    return <p className="flex h-[28rem] items-center justify-center text-sm text-ink-muted">The 3D body could not be built on this device. Use the flat diagram.</p>
  }

  // the front-most organ under the pointer wins; the skin only when no organ is there
  const regionAt = (e: ThreeEvent<PointerEvent | MouseEvent>) => {
    const hits = e.intersections.filter((i) => i.object.visible && i.object.userData.region)
    const organ = hits.find((i) => i.object.userData.region !== 'whole_body')
    return (organ ?? hits[0])?.object.userData.region as string | undefined
  }
  const nameOf = (id: string) => SYSTEM_INFO[id]?.name ?? regions?.find((r) => r.id === id)?.title ?? id
  const start = goalFor('whole_body', VIEWS.front)

  return (
    <div className={`relative h-[28rem] w-full ${hovered ? 'cursor-pointer' : 'cursor-grab'}`}>
      <Canvas camera={{ position: start.position.toArray(), fov: 34, near: 0.05, far: 30 }} dpr={[1, 2]}
        onPointerMissed={() => setHovered(null)}>
        <hemisphereLight args={['#ffffff', '#64748b', 1.1]} />
        <directionalLight position={[1.5, 3, 3]} intensity={1.6} />
        <directionalLight position={[-2, 1.5, -2.5]} intensity={0.7} color="#b4c8ff" />
        <group
          onPointerMove={(e) => { e.stopPropagation(); setHovered(regionAt(e) ?? null) }}
          onPointerOut={() => setHovered(null)}
          onClick={(e) => {
            e.stopPropagation()
            if (e.delta > 4) return // a drag, not a click
            const id = regionAt(e)
            if (id) onSelect(id)
          }}>
          {DRAW_ORDER.map((id) => geometries[id] && (
            <Organ key={id} id={id} geometry={geometries[id]} colour={STATUS_FILL[statusOf(regions, id)]}
              selected={selected === id} hovered={hovered === id}
              solid={selected === id || hovered === id || ['YELLOW', 'RED'].includes(statusOf(regions, id))} />
          ))}
          <Skin geometry={geometries.whole_body} visible={skin}
            colour={selected === 'whole_body' || hovered === 'whole_body' ? STATUS_FILL[statusOf(regions, 'whole_body')] : SKIN_TONE}
            glow={selected === 'whole_body' ? 1 : hovered === 'whole_body' ? 0.6 : 0} />
        </group>
        <ContactShadows position={[0, 0, 0]} opacity={0.35} scale={2.2} blur={2.4} far={1.2} resolution={256} />
        <OrbitControls makeDefault enablePan={false} enableDamping minDistance={0.6} maxDistance={5}
          minPolarAngle={0.15} maxPolarAngle={Math.PI - 0.15} target={start.target.toArray()}
          autoRotate={turning} autoRotateSpeed={0.8} />
        <CameraRig goal={goal} onUserMove={stopTurning} />
      </Canvas>

      <div className="absolute inset-x-2 top-2 flex flex-wrap justify-end gap-1" role="group" aria-label="3D view controls">
        {(['front', 'side', 'back'] as const).map((v) => (
          <button key={v} type="button" onClick={() => { setTurning(false); show(v) }}
            className="min-h-8 rounded-md border border-line bg-surface/90 px-2 text-xs font-medium capitalize hover:bg-subtle">{v}</button>
        ))}
        <button type="button" aria-pressed={turning} onClick={() => setTurning((t) => !t)}
          className={`min-h-8 rounded-md border px-2 text-xs font-medium ${turning ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-surface/90 hover:bg-subtle'}`}>Turn</button>
        <button type="button" aria-pressed={skin} onClick={() => setSkin((s) => !s)}
          className={`min-h-8 rounded-md border px-2 text-xs font-medium ${skin ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-surface/90 hover:bg-subtle'}`}>Skin</button>
      </div>
      <p className="pointer-events-none absolute bottom-2 left-2 max-w-[calc(100%-1rem)] rounded bg-surface/90 px-2 py-1 text-xs" aria-live="polite">
        {hovered
          ? <><span className="font-semibold">{nameOf(hovered)}</span> · {STATUS_LABEL[statusOf(regions, hovered)]}</>
          : <><span className="text-ink-muted">Showing</span> <span className="font-semibold">{nameOf(selected)}</span><span className="text-ink-muted"> · drag to turn, click a part</span></>}
      </p>
    </div>
  )
}
