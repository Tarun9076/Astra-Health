"""Symptoms offered in the daily check-in (shared by the API and the treatment protocols)."""

# Symptoms offered in the daily check-in. The red-flag ones (protocols/redflags.yaml, matched by symptom
# code) raise an Urgent alert with the emergency protocol, exactly as when reported to the assistant.
CHECKIN_SYMPTOMS: dict[str, str] = {
    "headache": "Headache",
    "congestion": "Blocked nose or head fullness",
    "nausea": "Nausea or space motion sickness",
    "dizziness": "Dizziness or light-headedness",
    "back_pain": "Back pain",
    "muscle_joint_pain": "Muscle or joint pain",
    "vision_change": "Change in vision",
    "sleep_trouble": "Trouble sleeping",
    "skin_irritation": "Skin rash or irritation",
    "low_mood": "Feeling low, anxious or irritable",
    "chest_pain": "Chest pain or pressure",
    "breathing_difficulty": "Severe difficulty breathing",
    "fainting": "Fainting or nearly fainting",
    "neuro_deficit": "Sudden weakness, numbness, confusion or slurred speech",
    "severe_bleeding": "Severe bleeding",
    "allergic_reaction": (
        "Swelling of the lips, tongue or throat, or an allergic reaction with trouble breathing"
    ),
}
