"""Canonical text shaping for model output.

The repo grew these helpers by copy-paste: five AI paths each carried their own
``_strip_code_fence`` and six carried their own ``_blocks_text``. The copies
drifted, which is worse than the duplication itself — the same §blocks were
rendered one way into a prompt and another way into a validation message.

This module is the single home for the two shapes that really are the same
everywhere. The deliberately *different* renderers stay where they are, each
with a docstring saying why it differs; they are not bugs, they serve different
consumers:

* ``apps/tutoring/services/core.py`` — prompt rendering that must not silently
  drop image blocks (it emits an explicit placeholder instead).
* ``apps/knowledge/services/suggestions.py`` — outline/tag text widening that
  reads ``text``/``latex``/``value`` and expands ``list`` blocks.
* ``apps/search/services/index.py`` — returns a list of indexable strings and
  also reads table/image-alt content.

Keep behaviour identical when adopting this module: it is a move, not a fix.
"""

from __future__ import annotations

from typing import Any


def strip_code_fence(text: str) -> str:
    """Remove one surrounding Markdown code fence from a model response.

    Models are told to answer with bare JSON and mostly obey; ````` ```json
    ... ````` still shows up. Only the outer fence is removed — anything that
    merely starts with a fence but has no closing fence keeps its body, which is
    the behaviour every caller already depends on.
    """
    cleaned = (text or "").strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[-1]
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3]
    return cleaned.strip()


def blocks_to_text(blocks: Any) -> str:
    """Render a content block list as prompt text: ``text`` plus ``$latex$``.

    Never answer-bearing: ``content.blocks`` holds the stem/explanation only, so
    this is safe to interpolate into a prompt and into validation messages.
    Unknown block kinds are skipped rather than stringified, so a future block
    kind cannot leak arbitrary payload into a prompt by accident.
    """
    if not isinstance(blocks, list):
        return ""
    parts: list[str] = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        if block.get("kind") == "text":
            parts.append(str(block.get("text", "")))
        elif block.get("kind") == "math":
            parts.append(f"${block.get('latex', '')}$")
    return " ".join(part for part in parts if part)
