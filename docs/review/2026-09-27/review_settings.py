"""Review-only settings. Always use a dedicated PostgreSQL test database."""
from config.settings.test import *
DATABASES['default']['TEST'] = {'NAME': 'test_acepass_independent_regressions_20260927'}
