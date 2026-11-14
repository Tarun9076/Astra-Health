// Stylised 3D body built from primitives (no external model, so no licence to track). Regions are
// separate meshes coloured by status; drag to rotate, click a region to open its panel.
import { OrbitControls } from '@react-three/drei'
import { Canvas, type ThreeEvent } from '@react-three/fiber'
import { useState, type ReactNode } from 'react'
import type { BodyRegion } from '../../lib/queries'
import { STATUS_FILL, STATUS_LABEL, statusOf } from './regions'

type Vec3 = [number, number, number]

function Part({ id, regions, selected, hovered, setHovered, onSelect, children, position, scale, rotation }: {
  id: string
  regions: BodyRegion[] | undefined
  selected: string
  hovered: string | null
  setHovered: (id: string | null) => void
  onSelect: (id: string) => void
  children: ReactNode
  position: Vec3
  scale?: Vec3
  rotation?: Vec3
}) {
  const active = selected === id || hovered === id
  const colour = STATUS_FILL[statusOf(regions, id)]
  const stop = (e: ThreeEvent<PointerEvent | MouseEvent>) => e.stopPropagation()
  return (
    <mesh position={position} scale={scale} rotation={rotation}
      onClick={(e) => { stop(e); onSelect(id) }}
      onPointerOver={(e) => { stop(e); setHovered(id) }}
      onPointerOut={() => setHovered(null)}>
      {children}
      <meshStandardMaterial color={colour} emissive={colour} emissiveIntensity={active ? 0.7 : 0.15}
        transparent opacity={active ? 0.95 : 0.7} />
    </mesh>
  )
}

export default function BodyModel3D({ regions, selected, onSelect }: {
  regions: BodyRegion[] | undefined
  selected: string
  onSelect: (id: string) => void
}) {
  const [hovered, setHovered] = useState<string | null>(null)
  const p = { regions, selected, hovered, setHovered, onSelect }
  const shell = STATUS_FILL[statusOf(regions, 'whole_body')]
  return (
    <div className="relative h-[28rem] w-full">
      <Canvas camera={{ position: [0, 1.1, 3.2], fov: 40 }} onPointerMissed={() => setHovered(null)}>
        <ambientLight intensity={0.6} />
        <directionalLight position={[2, 3, 4]} intensity={1.1} />
        {/* translucent body shell = whole body (radiation) */}
        <group onClick={(e) => { e.stopPropagation(); onSelect('whole_body') }}>
          {([
            [[0, 1.62, 0], [0.24, 0.27, 0.24]], [[0, 1.08, 0], [0.34, 0.5, 0.2]],
            [[-0.15, 0.38, 0], [0.11, 0.42, 0.11]], [[0.15, 0.38, 0], [0.11, 0.42, 0.11]],
            [[-0.46, 1.02, 0], [0.08, 0.36, 0.08]], [[0.46, 1.02, 0], [0.08, 0.36, 0.08]],
          ] as [Vec3, Vec3][]).map(([pos, s], i) => (
            <mesh key={i} position={pos} scale={s}>
              <sphereGeometry args={[1, 32, 24]} />
              <meshStandardMaterial color="#cbd5e1" emissive={shell} emissiveIntensity={selected === 'whole_body' ? 0.35 : 0.05}
                transparent opacity={0.28} depthWrite={false} />
            </mesh>
          ))}
        </group>
        <Part id="brain" {...p} position={[0, 1.68, 0]} scale={[0.17, 0.12, 0.16]}><sphereGeometry args={[1, 32, 24]} /></Part>
        <Part id="eyes" {...p} position={[-0.075, 1.6, 0.21]}><sphereGeometry args={[0.035, 16, 16]} /></Part>
        <Part id="eyes" {...p} position={[0.075, 1.6, 0.21]}><sphereGeometry args={[0.035, 16, 16]} /></Part>
        <Part id="lungs" {...p} position={[-0.13, 1.2, 0.02]} scale={[0.11, 0.18, 0.1]}><sphereGeometry args={[1, 24, 18]} /></Part>
        <Part id="lungs" {...p} position={[0.13, 1.2, 0.02]} scale={[0.11, 0.18, 0.1]}><sphereGeometry args={[1, 24, 18]} /></Part>
        <Part id="heart" {...p} position={[0.06, 1.16, 0.12]} scale={[0.075, 0.09, 0.07]}><sphereGeometry args={[1, 24, 18]} /></Part>
        <Part id="digestive" {...p} position={[0, 0.88, 0.04]} scale={[0.2, 0.13, 0.12]}><sphereGeometry args={[1, 24, 18]} /></Part>
        {([[-0.08, 1.42, 0.06], [0.08, 1.42, 0.06], [-0.28, 1.3, 0.04], [0.28, 1.3, 0.04]] as Vec3[]).map((pos, i) => (
          <Part key={`imm${i}`} id="immune" {...p} position={pos}><sphereGeometry args={[0.035, 16, 16]} /></Part>
        ))}
        {([[-0.46, 1.06, 0.02], [0.46, 1.06, 0.02], [-0.15, 0.55, 0.02], [0.15, 0.55, 0.02]] as Vec3[]).map((pos, i) => (
          <Part key={`mus${i}`} id="muscles" {...p} position={pos} scale={[0.06, i < 2 ? 0.22 : 0.2, 0.06]}><sphereGeometry args={[1, 20, 16]} /></Part>
        ))}
        {([[-0.15, 0.12, 0], [0.15, 0.12, 0]] as Vec3[]).map((pos, i) => (
          <Part key={`bone${i}`} id="bones" {...p} position={pos}><cylinderGeometry args={[0.025, 0.025, 0.42, 12]} /></Part>
        ))}
        <OrbitControls enablePan={false} minDistance={2} maxDistance={5} target={[0, 0.95, 0]} />
      </Canvas>
      {hovered && (
        <p className="pointer-events-none absolute top-2 left-2 rounded bg-surface/90 px-2 py-1 text-xs">
          {regions?.find((r) => r.id === hovered)?.title ?? hovered} · {STATUS_LABEL[statusOf(regions, hovered)]}
        </p>
      )}
      <p className="absolute right-2 bottom-2 text-[11px] text-ink-muted">Drag to rotate · scroll to zoom</p>
    </div>
  )
}
