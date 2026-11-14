import { ClipboardCheck, HeartPulse, History, House, Leaf, ListChecks, MessagesSquare, type LucideIcon } from 'lucide-react'

/** Astronaut navigation, organised around tasks (UI redesign). Order = how often each is needed. */
export const ASTRONAUT_NAV: { path: string; label: string; icon: LucideIcon; hint: string }[] = [
  { path: 'home', label: 'Home', icon: House, hint: 'How you are right now and what to do next' },
  { path: 'health', label: 'My Health', icon: HeartPulse, hint: 'Body systems and trends against your normal' },
  { path: 'checkin', label: 'Daily Check-in', icon: ClipboardCheck, hint: 'Guided measurements, about 2 minutes' },
  { path: 'guidance', label: 'My Guidance', icon: ListChecks, hint: 'Alerts and recommended actions' },
  { path: 'wellness', label: 'Wellness', icon: Leaf, hint: 'Exercise, sleep, mind, food and water' },
  { path: 'history', label: 'Health History', icon: History, hint: 'Timeline and medical reports' },
  { path: 'assistant', label: 'AI Assistant', icon: MessagesSquare, hint: 'Ask about your health in plain language' },
]

/** Task code of the daily check-in reminder (services/routine.py). */
export const CHECKIN_TASK = 'REC-WELLNESS-CHECKIN'
