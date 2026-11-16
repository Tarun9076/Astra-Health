import { create } from 'zustand'

interface Alarm { episodeId: string; astronautCode: string; astronautName: string; title: string }

/** Step 21: a crewmate started a critical treatment: every other crew device sounds until acknowledged. */
export const useCrewAlarm = create<{ alarm: Alarm | null; raise: (a: Alarm) => void; ack: () => void }>((set) => ({
  alarm: null,
  raise: (alarm) => set({ alarm }),
  ack: () => set({ alarm: null }),
}))
