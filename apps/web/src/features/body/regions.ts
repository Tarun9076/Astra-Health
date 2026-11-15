import { AlertOctagon, CheckCircle2, CircleHelp, TriangleAlert } from 'lucide-react'
import type { BodyRegion } from '../../lib/queries'

export type RegionStatus = BodyRegion['status']

// Status colours are the app's status tokens (never used for anything but status); GREY = no data.
export const STATUS_FILL: Record<RegionStatus, string> = {
  GREEN: 'var(--color-status-green)',
  YELLOW: 'var(--color-status-yellow)',
  RED: 'var(--color-status-red)',
  GREY: 'var(--color-grey)',
}

export const STATUS_ICON: Record<RegionStatus, typeof CheckCircle2> = {
  GREEN: CheckCircle2,
  YELLOW: TriangleAlert,
  RED: AlertOctagon,
  GREY: CircleHelp,
}

export const STATUS_LABEL: Record<RegionStatus, string> = {
  GREEN: 'Normal',
  YELLOW: 'Take care',
  RED: 'Get help now',
  GREY: 'No data yet',
}

export function statusOf(regions: BodyRegion[] | undefined, id: string): RegionStatus {
  return regions?.find((r) => r.id === id)?.status ?? 'GREY'
}

/** Plain-language description of each body system (educational; from the knowledge base). */
export const SYSTEM_INFO: Record<string, { name: string; does: string; monitored: string[]; symptoms: string[] }> = {
  brain: {
    name: 'Brain and nervous system',
    does: 'Controls thinking, mood, sleep, balance and every movement. Sleep and stress strongly affect how well it works.',
    monitored: ['Sleep duration and quality', 'Mood', 'Stress', 'Fatigue'],
    symptoms: ['Poor sleep for several nights', 'Low mood or anxiety that does not pass', 'Headache, dizziness or confusion', 'Sudden weakness, numbness or slurred speech (emergency)'],
  },
  eyes: {
    name: 'Eyes and vision',
    does: 'Vision depends on the eye, the optic nerve and the pressure of fluid around the brain.',
    monitored: ['Vision checks by the crew medical officer'],
    symptoms: ['Blurred near or far vision', 'Needing stronger glasses to read', 'Sudden loss of vision (emergency)'],
  },
  heart: {
    name: 'Heart and circulation',
    does: 'Pumps blood that carries oxygen and nutrients around the body and controls blood pressure.',
    monitored: ['Resting heart rate', 'Blood pressure', 'Heart rate (wearable)'],
    symptoms: ['Resting heart rate higher than usual for days', 'Dizziness when moving', 'Palpitations', 'Chest pain or pressure (emergency)'],
  },
  lungs: {
    name: 'Lungs and breathing',
    does: 'Brings oxygen into the blood and removes carbon dioxide. Cabin air quality matters directly.',
    monitored: ['Oxygen saturation', 'Cabin CO₂'],
    symptoms: ['Shortness of breath', 'Cough or chest tightness', 'Headache with high cabin CO₂', 'Severe difficulty breathing (emergency)'],
  },
  digestive: {
    name: 'Digestion and metabolism',
    does: 'Turns food and water into energy and keeps blood sugar, body weight and hydration in balance.',
    monitored: ['Blood glucose', 'Body weight', 'Water intake'],
    symptoms: ['Nausea or loss of appetite', 'Shakiness or sweating (possible low blood sugar)', 'Dark urine or headache (possible dehydration)'],
  },
  immune: {
    name: 'Immune system',
    does: 'Defends the body against infection. It can be weaker in space, and illness spreads easily in a closed cabin.',
    monitored: ['Body temperature'],
    symptoms: ['Fever or chills', 'Sore throat, cough or blocked nose', 'Skin rash or slow-healing cuts', 'Reactivated cold sores'],
  },
  muscles: {
    name: 'Muscles',
    does: 'Move and support the body. Without gravity they are used less and weaken, especially legs and back.',
    monitored: ['Exercise minutes', 'Strength on the exercise device'],
    symptoms: ['Back pain', 'Muscle soreness that does not settle', 'Falling strength results'],
  },
  bones: {
    name: 'Bones',
    does: 'Support the body and store calcium. In weightlessness bones lose mass, mainly in the hips and spine.',
    monitored: ['Exercise sessions per week', 'Water intake (kidney stone risk)'],
    symptoms: ['Bone or joint pain', 'Pain in the side or back (possible kidney stone)'],
  },
  whole_body: {
    name: 'Whole body · radiation',
    does: 'Radiation affects the whole body. Outside Earth’s magnetic field the dose is higher and adds up over the mission.',
    monitored: ['Personal radiation dose (total, charged particles, neutrons)', 'Solar particle events'],
    symptoms: ['Nausea or skin redness after a solar storm (tell the crew medical officer)'],
  },
}

/** Order of systems in the list next to the body map. */
export const SYSTEM_ORDER = ['brain', 'eyes', 'heart', 'lungs', 'digestive', 'immune', 'muscles', 'bones', 'whole_body']
