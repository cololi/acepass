from config.settings.test import *
DATABASES['default']['TEST'] = {'NAME': 'test_acepass_p02_independent_gaps'}
PRIVATE_MEDIA_ROOT = '/tmp/acepass-p02-independent-gaps-media'
MEDIA_ROOT = PRIVATE_MEDIA_ROOT
