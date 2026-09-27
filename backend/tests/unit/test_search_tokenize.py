"""Tokenizer contract: Chinese n-grams, latin/number handling, determinism.

Every assertion here is about a *rule*, not about an implementation detail: the
tokenizer is the part of retrieval that makes a ranking reproducible, so its
behaviour has to be pinned by tests rather than by convention.
"""

from __future__ import annotations

from apps.search.services.tokenize import TOKENIZER_VERSION, term_frequencies, tokenize


def test_cjk_run_emits_unigrams_then_adjacent_bigrams():
    assert tokenize("光合作用") == ["光", "合", "作", "用", "光合", "合作", "作用"]


def test_single_cjk_character_has_no_bigram():
    assert tokenize("光") == ["光"]


def test_punctuation_and_whitespace_are_separators_never_tokens():
    # Per CJK run: its unigrams, then its bigrams, in reading order.
    assert tokenize("你好，世界！") == ["你", "好", "你好", "世", "界", "世界"]


def test_bigrams_never_cross_a_punctuation_boundary():
    tokens = tokenize("光合，作用")
    assert tokens == ["光", "合", "光合", "作", "用", "作用"]
    assert "合作" not in tokens


def test_latin_and_digits_stay_whole_and_lowercase():
    assert tokenize("BM25 Model X1") == ["bm25", "model", "x1"]


def test_decimal_point_and_percent_stay_inside_numbers():
    assert tokenize("增长12.5%") == ["增", "长", "增长", "12.5%"]
    assert tokenize("圆周率 3.14") == ["圆", "周", "率", "圆周", "周率", "3.14"]


def test_sentence_period_does_not_join_tokens():
    assert tokenize("第1题。") == ["第", "1", "题"]
    # A trailing period is not part of the number either.
    assert tokenize("值 5.") == ["值", "5"]


def test_standalone_percent_is_dropped():
    assert tokenize("%") == []
    assert tokenize("50 %") == ["50"]


def test_nfkc_normalisation_collapses_fullwidth_and_compatibility_forms():
    assert tokenize("ＡＢＣ１２３") == ["abc123"]
    assert tokenize("％") == []
    assert tokenize("①号") == ["1", "号"]
    assert tokenize("ｂｍ２５") == ["bm25"]


def test_control_characters_and_emoji_are_dropped():
    assert tokenize("a\x00b\tc") == ["a", "b", "c"]
    assert tokenize("好👍题") == ["好", "题"]


def test_empty_and_whitespace_only_input_produce_no_tokens():
    assert tokenize("") == []
    assert tokenize("   \n\t ") == []
    assert tokenize("，。！？") == []


def test_tokenisation_is_deterministic():
    text = "下列关于 BM25 的说法，哪一项正确？光合作用与呼吸作用。"
    first = tokenize(text)
    assert first == tokenize(text)
    assert first == tokenize(text)
    assert "bm25" in first
    assert "说法" in first
    assert "光合" in first
    # No punctuation survives as a token.
    assert not [token for token in first if any(character in "，。？！" for character in token)]


def test_term_frequencies_counts_every_token_and_orders_by_term():
    tokens = tokenize("光合作用光合")
    frequencies = term_frequencies(tokens)
    assert frequencies["光"] == 2
    assert frequencies["合"] == 2
    assert frequencies["光合"] == 2
    assert frequencies["用光"] == 1
    assert sum(frequencies.values()) == len(tokens)
    assert list(frequencies) == sorted(frequencies)
    # Same input, same mapping — a re-index must not produce different statistics.
    assert frequencies == term_frequencies(tokenize("光合作用光合"))


def test_term_frequencies_of_no_tokens_is_empty():
    assert term_frequencies([]) == {}


def test_tokenizer_version_is_stable_because_reports_quote_it():
    assert TOKENIZER_VERSION == "zh-char-ngram-v1"
