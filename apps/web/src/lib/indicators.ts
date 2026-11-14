// Plain-language explanations for every measurement the astronaut sees (UI redesign).
// Educational text drawn from the knowledge base (knowledge/kb-*.md, NASA HRP hazard pages).
// It explains; it never decides. Severity always comes from the rules engine.

export type IndicatorInfo = {
  /** Short everyday name. */
  label: string
  /** What the number is, in one sentence. */
  what: string
  /** Why it matters during spaceflight. */
  why: string
  /** How to take it (check-in instructions). */
  how?: string
  /** When to ask for medical help (always paired with the rules engine's own alerts). */
  help?: string
  /** Knowledge-base note behind the text. */
  kb: string
  /** Body region on the Body Explorer. */
  region: string
}

export const INDICATOR_INFO: Record<string, IndicatorInfo> = {
  resting_hr: {
    label: 'Resting heart rate',
    what: 'How many times your heart beats per minute while you are fully at rest, best measured right after waking.',
    why: 'In weightlessness the heart works differently and fluids shift toward the head. A resting rate that stays above your own normal can mean poor recovery, fatigue, dehydration or illness.',
    how: 'Measure before getting up, before caffeine or exercise. Sit or lie still for 1 minute, then read the wearable or count your pulse for 60 seconds.',
    help: 'Ask the flight surgeon if it stays well above your normal for several days, or at once if you also have chest pain, fainting or breathlessness.',
    kb: 'kb-cardio-reduced-gravity',
    region: 'heart',
  },
  heart_rate: {
    label: 'Heart rate',
    what: 'Your pulse right now, measured continuously by the wearable.',
    why: 'Shows how hard your heart is working during exercise, work and rest.',
    kb: 'kb-cardio-reduced-gravity',
    region: 'heart',
  },
  bp_sys: {
    label: 'Blood pressure (upper number)',
    what: 'Systolic pressure: the pressure in your arteries when the heart beats.',
    why: 'Blood pressure regulation changes in reduced gravity. Low values can cause dizziness when you return to gravity; high values strain the heart and vessels.',
    how: 'Sit quietly for 5 minutes, cuff on the bare upper arm at heart level, feet flat, no talking. Take two readings 1 minute apart.',
    help: 'Get help at once if the upper number is very high with headache, chest pain, confusion or vision change.',
    kb: 'kb-blood-pressure',
    region: 'heart',
  },
  bp_dia: {
    label: 'Blood pressure (lower number)',
    what: 'Diastolic pressure: the pressure in your arteries between beats.',
    why: 'Read together with the upper number to judge the load on your heart and blood vessels.',
    kb: 'kb-blood-pressure',
    region: 'heart',
  },
  body_temp: {
    label: 'Body temperature',
    what: 'Your core body temperature in degrees Celsius.',
    why: 'The immune system can be weaker in space, and a closed cabin spreads infection easily. A raised temperature is often the first sign of infection; heat stress is also possible in a warm cabin.',
    how: 'Use the thermometer as trained (oral or ear), not within 15 minutes of eating, drinking or exercise.',
    help: 'Tell the flight surgeon about any fever. 39.5 °C or above is urgent.',
    kb: 'kb-immune-infection-fever',
    region: 'immune',
  },
  spo2: {
    label: 'Oxygen saturation',
    what: 'The percentage of your red blood cells carrying oxygen (SpO₂), from the pulse oximeter.',
    why: 'Low oxygen can come from cabin air problems, lung illness or decompression. Healthy values are usually 95–100 %.',
    how: 'Warm hand, finger still, nail polish off. Wait until the number is steady (about 30 seconds).',
    help: 'Below 90 % or any breathing difficulty is an emergency: follow the low-oxygen protocol.',
    kb: 'kb-oxygen-hypoxia',
    region: 'lungs',
  },
  glucose: {
    label: 'Blood glucose',
    what: 'The amount of sugar in your blood (mg/dL), from the glucose meter.',
    why: 'Stress, poor sleep, less activity and the space diet can change how the body handles sugar. Very low values affect thinking and safety.',
    how: 'Clean and dry the fingertip, use the side of the finger, apply the drop to the strip. Note if you ate in the last 2 hours.',
    help: 'Act at once on very low values (shaky, sweaty, confused): take fast sugar and tell the crew medical officer.',
    kb: 'kb-glucose-energy',
    region: 'digestive',
  },
  sleep_hours: {
    label: 'Sleep',
    what: 'Hours you slept last night.',
    why: 'Light–dark cycles, noise and workload disrupt sleep in space. Short sleep lowers alertness, mood and performance, and is a common driver of fatigue.',
    how: 'Use the wearable value or your best estimate of time actually asleep.',
    help: 'Talk to the flight surgeon if you sleep under 6 hours on several nights in a row.',
    kb: 'kb-sleep-circadian',
    region: 'brain',
  },
  sleep_quality: {
    label: 'Sleep quality',
    what: 'How restful your sleep felt, from 1 (very poor) to 10 (excellent).',
    why: 'Poor-quality sleep can leave you tired even after enough hours.',
    kb: 'kb-sleep-circadian',
    region: 'brain',
  },
  mood: {
    label: 'Mood',
    what: 'How you feel overall today, from 1 (very low) to 10 (great).',
    why: 'Isolation and confinement are known spaceflight hazards. A falling mood over several days is worth noticing early.',
    help: 'You can talk privately with the flight surgeon or psychological support at any time.',
    kb: 'kb-hazard-isolation',
    region: 'brain',
  },
  stress: {
    label: 'Stress',
    what: 'How stressed you feel today, from 1 (calm) to 10 (extreme).',
    why: 'Sustained stress affects sleep, the immune system and teamwork.',
    help: 'Use a breathing or relaxation session; ask for support if stress stays high.',
    kb: 'kb-stress-coping',
    region: 'brain',
  },
  fatigue: {
    label: 'Fatigue',
    what: 'How tired you feel today, from 1 (fresh) to 10 (exhausted).',
    why: 'Fatigue builds up from short sleep, heavy workload and illness, and raises the risk of errors in critical tasks.',
    kb: 'kb-fatigue-recovery',
    region: 'brain',
  },
  activity_min: {
    label: 'Exercise',
    what: 'Minutes of exercise recorded today.',
    why: 'Daily exercise is the main protection against muscle and bone loss in reduced gravity.',
    kb: 'kb-exercise-countermeasures',
    region: 'muscles',
  },
  radiation_dose: {
    label: 'Radiation dose',
    what: 'Your radiation dose today from the personal dosimeter, in millisieverts (mSv).',
    why: 'Outside Earth’s magnetic field, radiation exposure is higher and adds up over the mission. Solar storms can raise it quickly.',
    help: 'During a solar particle event, go to the shelter area as instructed by the radiation alert.',
    kb: 'kb-hazard-radiation',
    region: 'whole_body',
  },
  hydration_ml: {
    label: 'Water intake',
    what: 'Millilitres of water you drank today.',
    why: 'Thirst is weaker in weightlessness; low intake raises the risk of kidney stones and headaches.',
    kb: 'kb-hydration',
    region: 'digestive',
  },
  strength_index: {
    label: 'Strength',
    what: 'Your strength on the exercise device compared with your pre-flight level (100 % = pre-flight).',
    why: 'Muscles weaken without gravity; this shows whether your exercise is protecting them.',
    kb: 'kb-muscle-fitness',
    region: 'muscles',
  },
}

export function infoFor(code: string): IndicatorInfo | undefined {
  return INDICATOR_INFO[code]
}

/** Decimal places used to show each unit. */
export function decimalsFor(unit: string): number {
  return unit === 'mSv' ? 3 : unit === 'h' || unit === '°C' ? 1 : 0
}

/** "/10" for scores, otherwise the unit. */
export function unitLabel(unit: string): string {
  return unit === 'score' ? '/10' : unit
}
