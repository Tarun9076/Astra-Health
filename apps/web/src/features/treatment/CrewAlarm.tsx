import { useQuery } from '@tanstack/react-query'
import { Siren } from 'lucide-react'
import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { beep } from '../../lib/alarm'
import { api, unwrap } from '../../lib/api'
import { useDoses, useFormulary, useMedicalProfile } from '../medication/medication'
import { useCrewAlarm } from './alarmStore'

export function CrewAlarm() {
  const { alarm, ack } = useCrewAlarm()
  useEffect(() => {
    if (!alarm) return
    beep(4)
    const id = window.setInterval(() => beep(4), 4000)
    return () => window.clearInterval(id)
  }, [alarm])
  if (!alarm) return null
  return (
    <div role="alert" className="no-print flex flex-wrap items-center gap-3 border-b-4 border-status-red bg-status-red px-4 py-3 text-on-status">
      <Siren className="h-7 w-7 shrink-0" aria-hidden />
      <p className="flex-1 text-lg font-bold">{alarm.astronautName} needs help: {alarm.title}</p>
      <Link to={`/astronaut/act?episode=${alarm.episodeId}`} onClick={ack}
        className="inline-flex min-h-12 items-center rounded-lg bg-surface px-4 text-base font-bold text-status-red">
        Open the treatment
      </Link>
      <button type="button" onClick={ack} className="inline-flex min-h-12 items-center rounded-lg border-2 border-on-status px-4 text-base font-semibold">
        Silence
      </button>
    </div>
  )
}

/**
 * Keeps on this device what the on-device engine needs if the server goes down: the astronaut's
 * allergy profile, recent doses, kit stock and the crew list (saved with the offline cache for a day).
 */
export function KeepTreatmentDataReady({ code }: { code: string }) {
  useMedicalProfile(code)
  useDoses(code)
  useFormulary()
  useQuery({ queryKey: ['treatment-protocols'], queryFn: () => unwrap(api.GET('/api/treatment/protocols')), staleTime: 60 * 60_000 })
  return null
}
