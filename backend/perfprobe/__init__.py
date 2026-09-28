"""Query-budget probe for AcePass read paths (measurement, not acceptance).

This package is intentionally *outside* ``tests/``: ``pytest.ini`` sets
``testpaths = tests`` so the acceptance count (489 passed) is unaffected, while
``pytest perfprobe`` still runs against the real PostgreSQL test database.

See ``test_query_budget.py`` for usage.
"""
