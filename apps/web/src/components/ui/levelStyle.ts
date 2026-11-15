import { AlertOctagon, CheckCircle2, TriangleAlert } from 'lucide-react'
import type { Level } from '../../lib/plain'

/** Colours, icon and word for the three levels (OK, take care, get help): never colour alone. */
export const LEVEL_STYLE: Record<Level, { box: string; text: string; icon: typeof CheckCircle2; word: string }> = {
  ok: { box: 'border-status-green/40 bg-status-green/10', text: 'text-status-green', icon: CheckCircle2, word: 'OK' },
  care: { box: 'border-status-yellow/40 bg-status-yellow/10', text: 'text-status-yellow', icon: TriangleAlert, word: 'Take care' },
  help: { box: 'border-status-red bg-status-red/10', text: 'text-status-red', icon: AlertOctagon, word: 'Get help' },
}
