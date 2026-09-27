from config.settings.test import *
DATABASES['default']['TEST'] = {'NAME': 'test_acepass_p01_independent_gaps'}
PRIVATE_MEDIA_ROOT = '/tmp/acepass-p01-independent-gap-media'
MEDIA_ROOT = PRIVATE_MEDIA_ROOT
