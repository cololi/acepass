import pytest
from unittest.mock import Mock
from django.utils import timezone
from datetime import timedelta
from apps.audit.services import outbox
from apps.audit.models import OutboxEvent
from apps.audit.tasks import rebuild_attempt_evidence
from apps.common.enums import OutboxStatus

pytestmark = pytest.mark.django_db

def test_real_consumer_refuses_another_live_claim(monkeypatch, settings):
    settings.ACEPASS_INLINE_TASKS = False
    from apps.learning.services import evidence
    spy = Mock(return_value=0)
    monkeypatch.setattr(evidence, 'rebuild_for_attempt', spy)
    event = outbox.enqueue('projection.rebuild_attempt_evidence', {'attempt_id':'irrelevant'})
    claim = outbox.claim_event(str(event.id))
    assert claim is not None
    rebuild_attempt_evidence.run(attempt_id='irrelevant',outbox_event_id=str(event.id))
    event.refresh_from_db()
    assert spy.call_count == 0, f'real consumer executed {spy.call_count} times while another lease was active; status={event.status}'

def test_stale_failure_cannot_reopen_processed_event():
    event = outbox.enqueue('learning.refresh_delayed_tasks', {})
    outbox.mark_processed(str(event.id))
    outbox.mark_retryable_failure(event, 'older consumer failed after newer one completed')
    event.refresh_from_db()
    assert event.status == OutboxStatus.PROCESSED, f'completed event changed to {event.status} while processed_at={event.processed_at}'

def test_successfully_sent_but_lost_messages_obey_retry_cap(monkeypatch, settings):
    settings.ACEPASS_INLINE_TASKS = False
    from config.celery import app
    monkeypatch.setattr(app, 'send_task', Mock())
    event = outbox.enqueue('learning.refresh_delayed_tasks', {})
    event.max_attempts = 1
    event.save(update_fields=['max_attempts'])
    outbox.dispatch_pending()
    OutboxEvent.objects.filter(id=event.id).update(lease_expires_at=timezone.now()-timedelta(seconds=1))
    outbox.dispatch_pending()
    event.refresh_from_db()
    assert event.attempts <= event.max_attempts, f'redelivery exceeded cap: {event.attempts}>{event.max_attempts}'
