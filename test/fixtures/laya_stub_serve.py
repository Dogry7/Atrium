"""Run the REAL `laya.serve` FastAPI app (laya-serve's /v1/systemone + /health) with a stub
Router in place of the model weights, so Atrium's Laya connector is tested against Laya's
actual HTTP surface (routing, auth, validation, response shape).

    python3 laya_stub_serve.py <port>      # optional env: LAYA_API_KEY
"""
import re
import sys

import uvicorn
from laya.serve import create_app


class StubRouter:
    loaded = ["english"]

    def predict(self, state, questions, model=None):
        text = state if isinstance(state, str) else str(state)
        words = set(re.findall(r"[a-z]+", text.lower()))
        answers = {}
        for key, q in questions.items():
            t = q.get("type")
            if t not in ("choice", "score", "noul"):
                raise ValueError("question %r: unknown type %r" % (key, t))
            if t == "choice":
                crit = q.get("criteria") or {}
                scores = {}
                for label, desc in crit.items():
                    kw = set(re.findall(r"[a-z]+", ("%s %s" % (label, desc)).lower()))
                    scores[label] = 1 + 3 * len(words & kw)
                total = float(sum(scores.values()))
                probs = {k: round(v / total, 4) for k, v in scores.items()}
                best = max(probs, key=probs.get)
                answers[key] = {"type": "choice", "choice": best, "probabilities": probs,
                                "confidence": probs[best], "action": {"act_probability": 0.5}}
            elif t == "score":
                levels = q.get("criteria") or ["low", "high"]
                urgent = 1.0 if words & {"urgent", "asap", "down", "outage"} else 0.2
                answers[key] = {"type": "score", "score": round(urgent * (len(levels) - 1), 4),
                                "probabilities": {str(i): round(1.0 / len(levels), 4) for i in range(len(levels))},
                                "confidence": 0.8, "action": {"act_probability": 0.5}}
            else:
                p = 0.9 if words & {"cancel", "refund", "leave"} else 0.1
                answers[key] = {"type": "noul", "noul": p, "confidence": max(p, 1 - p), "action": {"act_probability": 0.5}}
        return {"model": "laya-stub", "answers": answers, "usage": {"input_tokens": len(text), "output_tokens": 0},
                "routing": {"model": model or "english", "reason": "stub"}}


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    uvicorn.run(create_app(router=StubRouter()), host="127.0.0.1", port=port, log_level="warning")
