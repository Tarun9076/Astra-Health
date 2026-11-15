import { ClipboardCheck, HeartPulse, History, House, Leaf, ListChecks, MessagesSquare, Pill, type LucideIcon } from 'lucide-react'

/** Astronaut navigation, organised around tasks (UI redesign). Order = how often each is needed. */
export const ASTRONAUT_NAV: { path: string; label: string; icon: LucideIcon; hint: string }[] = [
  { path: 'home', label: 'Home', icon: House, hint: 'How am I today?' },
  { path: 'health', label: 'My Health', icon: HeartPulse, hint: 'My body, part by part' },
  { path: 'checkin', label: 'Daily Check-in', icon: ClipboardCheck, hint: '2-minute daily measurements' },
  { path: 'guidance', label: 'My Guidance', icon: ListChecks, hint: 'What should I do?' },
  { path: 'medicine', label: 'Medicines', icon: Pill, hint: 'What can I safely take?' },
  { path: 'wellness', label: 'Wellness', icon: Leaf, hint: 'Exercise, sleep, mind, water' },
  { path: 'history', label: 'Health History', icon: History, hint: 'What happened so far' },
  { path: 'assistant', label: 'AI Assistant', icon: MessagesSquare, hint: 'Ask anything, simply' },
]

/** Task code of the daily check-in reminder (services/routine.py). */
export const CHECKIN_TASK = 'REC-WELLNESS-CHECKIN'
