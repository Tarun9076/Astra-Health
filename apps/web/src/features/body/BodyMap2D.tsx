import type { KeyboardEvent } from 'react'
import type { BodyRegion } from '../../lib/queries'
import { DRAW_ORDER } from './anatomy'
import { BODY_VIEWBOX, REGION_PATHS, SKIN_PATH } from './bodyMapPaths'
import { STATUS_FILL, STATUS_LABEL, statusOf, SYSTEM_INFO } from './regions'

const LABEL: Record<string, string> = {
  brain: 'Brain & nervous system',
  eyes: 'Eyes & vision (SANS)',
  heart: 'Heart & circulation',
  lungs: 'Lungs & breathing',
  digestive: 'Metabolism & digestion',
  immune: 'Immune system',
  muscles: 'Muscles',
  bones: 'Bones',
  whole_body: 'Whole body (radiation)',
}

function Region({ id, d, regions, selected, onSelect }: {
  id: string
  d: string
  regions: BodyRegion[] | undefined
  selected: string
  onSelect: (id: string) => void
}) {
  const status = statusOf(regions, id)
  const active = selected === id
  // like the 3D view: the chosen system and anything not within normal are solid, the rest faint
  const solid = active || status === 'YELLOW' || status === 'RED'
  const label = LABEL[id] ?? SYSTEM_INFO[id]?.name ?? id
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onSelect(id)
    }
  }
  return (
    <g role="button" tabIndex={0} aria-label={`${label}: ${STATUS_LABEL[status]}`} aria-pressed={active}
      onClick={() => onSelect(id)} onKeyDown={onKey}
      className="group cursor-pointer outline-none [&:focus-visible>path]:stroke-[#146eb8] [&:focus-visible>path]:[stroke-width:2.5]">
      <title>{label} — {STATUS_LABEL[status]}</title>
      <path d={d} fillRule="evenodd" fill={STATUS_FILL[status]} stroke={active ? '#172033' : STATUS_FILL[status]}
        strokeWidth={active ? 1.4 : 0.6} strokeLinejoin="round"
        className={`transition-opacity ${solid ? 'opacity-95' : 'opacity-25 group-hover:opacity-70'}`}
        filter={solid ? 'url(#organ-depth)' : undefined} />
    </g>
  )
}

/**
 * Front-view body diagram (SVG), drawn from the same anatomy model as the 3D view. Each system is a
 * keyboard-accessible button coloured by its status; the skin is the whole body (radiation).
 */
export function BodyMap2D({ regions, selected, onSelect }: {
  regions: BodyRegion[] | undefined
  selected: string
  onSelect: (id: string) => void
}) {
  const p = { regions, selected, onSelect }
  const whole = statusOf(regions, 'whole_body')
  const wholeActive = selected === 'whole_body'
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onSelect('whole_body')
    }
  }
  return (
    <svg viewBox={BODY_VIEWBOX} className="mx-auto h-[28rem] w-auto max-w-full" role="group" aria-label="Body map">
      <defs>
        {/* soft shading so the body reads as rounded, lit from the upper left */}
        <radialGradient id="skin-shade" cx="42%" cy="30%" r="75%">
          <stop offset="0%" stopColor="#f3e2d4" />
          <stop offset="60%" stopColor="#e3c6b0" />
          <stop offset="100%" stopColor="#c9a58c" />
        </radialGradient>
        <filter id="organ-depth" x="-10%" y="-10%" width="120%" height="120%">
          <feGaussianBlur in="SourceAlpha" stdDeviation="1.2" result="blur" />
          <feSpecularLighting in="blur" surfaceScale="2.5" specularConstant="0.5" specularExponent="18" lightingColor="#ffffff" result="spec">
            <fePointLight x="40" y="-60" z="120" />
          </feSpecularLighting>
          <feComposite in="spec" in2="SourceAlpha" operator="in" result="lit" />
          <feComposite in="SourceGraphic" in2="lit" operator="arithmetic" k1="0" k2="1" k3="0.6" k4="0" />
        </filter>
      </defs>
      <g role="button" tabIndex={0} aria-label={`${LABEL.whole_body}: ${STATUS_LABEL[whole]}`} aria-pressed={wholeActive}
        onClick={() => onSelect('whole_body')} onKeyDown={onKey}
        className="cursor-pointer outline-none [&:focus-visible>path]:stroke-[#146eb8] [&:focus-visible>path]:[stroke-width:2.5]">
        <title>{LABEL.whole_body} — {STATUS_LABEL[whole]}</title>
        <path d={SKIN_PATH} fillRule="evenodd" fill="url(#skin-shade)" fillOpacity={0.9}
          stroke={wholeActive ? STATUS_FILL[whole] : '#a8836a'} strokeWidth={wholeActive ? 2.2 : 0.8} strokeLinejoin="round" />
      </g>
      {DRAW_ORDER.map((id) => <Region key={id} id={id} d={REGION_PATHS[id]} {...p} />)}
    </svg>
  )
}
