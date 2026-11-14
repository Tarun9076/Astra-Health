import type { KeyboardEvent, ReactNode } from 'react'
import type { BodyRegion } from '../../lib/queries'
import { STATUS_FILL, STATUS_LABEL, statusOf } from './regions'

interface RegionProps {
  id: string
  label: string
  children: ReactNode
  regions: BodyRegion[] | undefined
  selected: string
  onSelect: (id: string) => void
}

function Region({ id, label, children, regions, selected, onSelect }: RegionProps) {
  const status = statusOf(regions, id)
  const active = selected === id
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onSelect(id)
    }
  }
  return (
    <g role="button" tabIndex={0} aria-label={`${label}: ${STATUS_LABEL[status]}`} aria-pressed={active}
      onClick={() => onSelect(id)} onKeyDown={onKey} className="cursor-pointer outline-none [&:focus-visible>*]:stroke-white"
      fill={STATUS_FILL[status]} fillOpacity={active ? 0.85 : 0.45} stroke={active ? '#e6ecff' : STATUS_FILL[status]}
      strokeWidth={active ? 2.5 : 1}>
      <title>{label} — {STATUS_LABEL[status]}</title>
      {children}
    </g>
  )
}

/** Front-view body map (SVG). Each region is a keyboard-accessible button coloured by its status. */
export function BodyMap2D({ regions, selected, onSelect }: {
  regions: BodyRegion[] | undefined
  selected: string
  onSelect: (id: string) => void
}) {
  const p = { regions, selected, onSelect }
  const whole = statusOf(regions, 'whole_body')
  return (
    <svg viewBox="0 0 240 500" className="mx-auto h-[28rem] w-auto max-w-full" role="group" aria-label="Body map">
      {/* silhouette (radiation = whole body: outline colour) */}
      <g fill="#1c2742" stroke={STATUS_FILL[whole]} strokeOpacity={selected === 'whole_body' ? 1 : 0.5}
        strokeWidth={selected === 'whole_body' ? 3 : 1.5}>
        <circle cx="120" cy="56" r="36" />
        <rect x="108" y="88" width="24" height="18" rx="6" />
        <rect x="72" y="104" width="96" height="170" rx="34" />
        <rect x="40" y="112" width="26" height="150" rx="13" transform="rotate(8 53 112)" />
        <rect x="174" y="112" width="26" height="150" rx="13" transform="rotate(-8 187 112)" />
        <rect x="82" y="262" width="34" height="200" rx="16" />
        <rect x="124" y="262" width="34" height="200" rx="16" />
      </g>
      <Region id="muscles" label="Muscles" {...p}>
        <rect x="44" y="132" width="18" height="70" rx="9" transform="rotate(8 53 132)" />
        <rect x="178" y="132" width="18" height="70" rx="9" transform="rotate(-8 187 132)" />
        <rect x="86" y="280" width="26" height="80" rx="12" />
        <rect x="128" y="280" width="26" height="80" rx="12" />
      </Region>
      <Region id="bones" label="Bones" {...p}>
        <rect x="96" y="370" width="8" height="84" rx="4" />
        <rect x="136" y="370" width="8" height="84" rx="4" />
        <rect x="92" y="252" width="56" height="12" rx="6" />
      </Region>
      <Region id="lungs" label="Lungs & breathing" {...p}>
        <ellipse cx="100" cy="160" rx="18" ry="34" />
        <ellipse cx="140" cy="160" rx="18" ry="34" />
      </Region>
      <Region id="heart" label="Heart & circulation" {...p}>
        <path d="M128 150c4-9 18-8 18 3 0 9-11 16-18 23-7-7-18-14-18-23 0-11 14-12 18-3z" />
      </Region>
      <Region id="digestive" label="Metabolism & digestion" {...p}>
        <ellipse cx="120" cy="228" rx="34" ry="26" />
      </Region>
      <Region id="immune" label="Immune system" {...p}>
        <circle cx="106" cy="100" r="5" />
        <circle cx="134" cy="100" r="5" />
        <circle cx="80" cy="124" r="5" />
        <circle cx="160" cy="124" r="5" />
      </Region>
      <Region id="brain" label="Brain & behaviour" {...p}>
        <ellipse cx="120" cy="44" rx="27" ry="18" />
      </Region>
      <Region id="eyes" label="Eyes & vision (SANS)" {...p}>
        <circle cx="108" cy="66" r="5" />
        <circle cx="132" cy="66" r="5" />
      </Region>
    </svg>
  )
}
