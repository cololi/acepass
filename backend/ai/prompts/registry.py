"""Versioned prompts and payload validation — compatibility barrel.

The definitions used to sit in this one 1,049-line module. Prompt edits forced a
reader through every unrelated prompt family, so each family now has its own
module (`extraction`, `explain`, `tags`, `transcription`, `estimation`,
`diagnosis`, `variant`).

This barrel re-exports every name that used to live here, explicitly, because
eight call sites read ``from ai.prompts import registry as prompts``. Adding a
family means adding its public names below; never an ``import *``.
"""

from __future__ import annotations

from ai.prompts.diagnosis import (  # noqa: F401
    DIAGNOSE_PROMPT_VERSION,
    DIAGNOSE_SYSTEM,
    DIAGNOSIS_ERROR_TYPES,
    build_diagnose_prompt,
    validate_diagnosis,
)
from ai.prompts.estimation import (  # noqa: F401
    ESTIMATE_GRADE_PROMPT_VERSION,
    ESTIMATE_SYSTEM,
    build_estimate_prompt,
    validate_estimate,
)
from ai.prompts.explain import (  # noqa: F401
    EXPLAIN_PROMPT_VERSION,
    EXPLAIN_SYSTEM,
    build_explain_prompt,
    validate_explain_payload,
)
from ai.prompts.extraction import (  # noqa: F401
    EXTRACT_PROMPT_VERSION,
    EXTRACT_SYSTEM,
    build_extract_prompt,
    validate_extract_payload,
)
from ai.prompts.tags import (  # noqa: F401
    SUGGEST_TAGS_PROMPT_VERSION,
    SUGGEST_TAGS_SYSTEM,
    build_tag_suggestion_prompt,
    validate_tag_suggestions,
)
from ai.prompts.transcription import (  # noqa: F401
    TRANSCRIBE_PROMPT_VERSION,
    TRANSCRIBE_SYSTEM,
    build_transcribe_prompt,
    validate_transcription,
)
from ai.prompts.variant import (  # noqa: F401
    PROPOSE_VARIANT_PROMPT_VERSION,
    VARIANT_SYSTEM,
    build_variant_prompt,
    validate_variant_payload,
)
