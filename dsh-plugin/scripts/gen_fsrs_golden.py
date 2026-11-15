"""Emit golden vectors for the FSRS-4.5 scheduler from the *Python* implementation.

The Node port (src/domain/fsrs.ts) must reproduce these byte-for-byte (floats to 1e-9).
Run:  npm run golden:fsrs
"""
import json, sys, itertools, random
from datetime import datetime, timedelta, UTC
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))
from domain.memory import fsrs  # noqa: E402

def iso(d): return None if d is None else d.astimezone(UTC).isoformat().replace("+00:00", "Z")

def state_json(s):
    return {"stability": s.stability, "difficulty": s.difficulty, "phase": s.phase, "reps": s.reps,
            "lapses": s.lapses, "learning_step": s.learning_step, "last_reviewed_at": iso(s.last_reviewed_at),
            "due_at": iso(s.due_at), "scheduled_days": s.scheduled_days, "elapsed_days": s.elapsed_days}

rng = random.Random(20260928)
T0 = datetime(2026, 1, 1, 8, 0, 0, tzinfo=UTC)
gaps_min = [0, 1, 3, 10, 60, 600, 1440, 3000, 14400, 43200, 200000]
sequences = []
# exhaustive short sequences + seeded random long ones
for ratings in itertools.product(fsrs.RATINGS, repeat=3):
    sequences.append((list(ratings), [rng.choice(gaps_min) for _ in ratings]))
for _ in range(120):
    n = rng.randint(4, 14)
    sequences.append(([rng.choice(fsrs.RATINGS) for _ in range(n)], [rng.choice(gaps_min) for _ in range(n)]))

out = {"fsrs_version": fsrs.FSRS_VERSION, "weights": list(fsrs.DEFAULT_WEIGHTS), "cases": [], "scalars": []}
for ratings, gaps in sequences:
    state = fsrs.CardState(); now = T0; steps = []
    for r, g in zip(ratings, gaps):
        now = now + timedelta(minutes=g)
        res = fsrs.schedule(state, r, now)
        steps.append({"rating": r, "at": iso(now), "retrievability": res.retrievability,
                      "interval_days": res.interval_days, "elapsed_days": res.elapsed_days,
                      "phase_after": res.phase_after, "is_lapse": res.is_lapse, "state": state_json(res.state)})
        state = res.state
    out["cases"].append({"steps": steps})
for s in (0.01, 0.5, 1, 3.7, 40, 900):
    for e in (0, 0.2, 1, 7, 365):
        out["scalars"].append({"fn": "retrievability", "args": [e, s], "value": fsrs.retrievability(e, s)})
    for ret in (0.7, 0.9, 0.97):
        out["scalars"].append({"fn": "next_interval_days", "args": [s, ret], "value": fsrs.next_interval_days(s, ret)})
print(json.dumps(out, indent=1))
