"""Deterministic, dependency-free tokenizer for Chinese exam text.

Why this module exists
----------------------
AcePass content is Chinese exam material. Whitespace tokenisation finds nothing
in ``下列哪一项符合题意``, and an external segmenter (jieba and friends) would add
a dependency whose dictionary version silently changes ranking between two runs
of the same query — retrieval evidence has to be reproducible.

The tokenizer here is deliberately fixed and documented:

* NFKC normalisation runs first, so full-width and compatibility spellings
  collapse onto one form (``ＡＢＣ１２`` → ``abc12``, ``①`` → ``1``, ``％`` → ``%``);
* latin letters, digits, ``%`` and decimal points *inside* numbers stay whole
  (``bm25``, ``3.14``, ``50%``), which keeps model numbers and units searchable;
* every CJK run contributes its character unigrams **and** its adjacent bigrams:
  the unigrams keep recall for single-character terms and the bigrams restore
  precision for words such as ``光合作用``;
* everything else — punctuation, whitespace, control characters, emoji — is a
  separator and never becomes a token.

Token order is the text order (unigrams of a run, then that run's bigrams), so
the same input always produces the same list. ``TOKENIZER_VERSION`` is reported
by the search API and by ``manage.py search_eval`` so that an acceptance report
names the exact tokenizer that produced it.
"""

from __future__ import annotations

import unicodedata
from collections import Counter
from collections.abc import Iterable

#: Bumped whenever the tokenisation rules change; reported in search responses.
TOKENIZER_VERSION = "zh-char-ngram-v1"

#: CJK ideograph ranges that participate in unigram+bigram tokenisation.
#: CJK punctuation (U+3000..U+303F) and kana are intentionally *not* included:
#: punctuation separates runs, and kana is not part of the Chinese exam corpus.
_CJK_RANGES: tuple[tuple[int, int], ...] = (
    (0x3400, 0x4DBF),  # CJK Unified Ideographs Extension A
    (0x4E00, 0x9FFF),  # CJK Unified Ideographs
    (0xF900, 0xFAFF),  # CJK Compatibility Ideographs
    (0x20000, 0x2FA1F),  # Extensions B..F (supplementary plane)
)


def is_cjk(character: str) -> bool:
    """True when ``character`` is a CJK ideograph we segment ourselves."""
    code = ord(character)
    return any(start <= code <= end for start, end in _CJK_RANGES)


def _is_word_character(character: str) -> bool:
    """Latin letters and digits (after NFKC) form whole-word tokens."""
    return character.isalnum()


def _runs(text: str) -> list[tuple[str, str]]:
    """Split normalised text into ordered ``(kind, value)`` runs.

    ``kind`` is ``"cjk"`` or ``"word"``. Punctuation and control characters are
    separators and never appear in the output.
    """
    runs: list[tuple[str, str]] = []
    buffer: list[str] = []
    kind = ""

    def flush() -> None:
        nonlocal buffer, kind
        if buffer:
            runs.append((kind, "".join(buffer)))
        buffer = []
        kind = ""

    length = len(text)
    for index, character in enumerate(text):
        if is_cjk(character):
            if kind != "cjk":
                flush()
                kind = "cjk"
            buffer.append(character)
            continue
        if _is_word_character(character):
            if kind != "word":
                flush()
                kind = "word"
            buffer.append(character)
            continue
        if character == "." and kind == "word" and buffer and buffer[-1].isdigit():
            # A decimal point stays inside a number ("3.14") but a sentence
            # period ("第一。") never joins two tokens.
            if index + 1 < length and text[index + 1].isdigit():
                buffer.append(character)
                continue
        if character == "%" and kind == "word" and buffer and (buffer[-1].isdigit() or buffer[-1] == "."):
            buffer.append(character)
            continue
        flush()
    flush()
    return runs


def tokenize(text: str) -> list[str]:
    """Return the ordered token list for ``text``.

    The result is deterministic: identical input always yields an identical
    list, and the order is the reading order of the source text.
    """
    if not text:
        return []
    normalized = unicodedata.normalize("NFKC", str(text)).casefold()
    tokens: list[str] = []
    for kind, run in _runs(normalized):
        if kind == "cjk":
            tokens.extend(run)
            tokens.extend(run[index : index + 2] for index in range(len(run) - 1))
        else:
            tokens.append(run)
    return tokens


def term_frequencies(tokens: Iterable[str]) -> dict[str, int]:
    """Term → occurrence count, ordered by term for stable JSON output."""
    counts = Counter(tokens)
    return {term: counts[term] for term in sorted(counts)}
