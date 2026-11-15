"""Prompts — P1 handwriting transcription prompt and validation."""

from __future__ import annotations

from typing import Any

TRANSCRIBE_PROMPT_VERSION = "p1-transcribe-v1"


TRANSCRIBE_SYSTEM = """你是手写作答的转写助手。你的唯一任务是把照片中的手写内容转写成文字。
严格规则：
1. 只输出 JSON，不要输出解释文字或 Markdown 代码块。
2. 只转写照片中真实存在的内容；看不清的字用“□”占位，并把位置写进 doubts。
3. 不要纠正、补全或“猜”学习者的推导；不要替他算出答案。
4. 不要判断对错，不要给分数，不要写掌握程度。
5. 如果整张图都看不清，text 返回空字符串并把 illegible 设为 true。
输出 JSON 结构：
{"text": "转写文本", "confidence": 0.0, "doubts": ["不确定之处"], "illegible": false}"""


def build_transcribe_prompt(*, subject_name: str, question_stem: str = "", note: str = "") -> str:
    return (
        f"{TRANSCRIBE_SYSTEM}\n\n"
        f"科目：{subject_name}\n"
        f"题目（仅供理解上下文，不要在转写里复制）：{question_stem[:800] or '（未提供）'}\n"
        f"补充说明：{note or '（无）'}\n"
        "请转写这张照片中的手写作答，输出 JSON。"
    )


def validate_transcription(payload: dict[str, Any]) -> tuple[dict[str, Any], list[dict]]:
    """Normalise one transcription proposal; never invent text that was not read."""
    problems: list[dict] = []
    if not isinstance(payload, dict):
        return {"text": "", "confidence": None, "doubts": [], "illegible": True}, [
            {"code": "not_object", "message": "模型输出不是对象"}
        ]
    text = str(payload.get("text") or "").strip()[:8000]
    doubts = [str(item)[:200] for item in (payload.get("doubts") or []) if str(item).strip()][:20]
    try:
        confidence = float(payload.get("confidence")) if payload.get("confidence") is not None else None
    except (TypeError, ValueError):
        confidence = None
        problems.append({"code": "bad_confidence", "message": "confidence 不是数字，已忽略"})
    if confidence is not None:
        confidence = max(0.0, min(1.0, confidence))
    illegible = bool(payload.get("illegible")) or not text
    if illegible and not doubts:
        doubts.append("模型认为照片无法辨认")
    if not text:
        problems.append({"code": "empty_transcription", "message": "模型没有读出任何文字"})
    return {"text": text, "confidence": confidence, "doubts": doubts, "illegible": illegible}, problems
