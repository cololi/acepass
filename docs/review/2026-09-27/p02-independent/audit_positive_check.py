from decimal import Decimal
import pytest
from django.core.management import call_command
from apps.audit.models import ContentRevision
from apps.practice.models import GradeEvent
from apps.practice.services.attempts import submit_attempt
pytest_plugins=['tests.conftest']
@pytest.mark.django_db
def test_history_audit_preserves_superseded_and_records_current(practice_item):
    item=practice_item
    attempt, grade=submit_attempt(session_item_id=str(item.id),user=item.session.user,raw_answer={'type':'single_choice','selected_option_ids':[item.answer_key_version.answer_payload['correct_option_id']]})
    GradeEvent.objects.filter(id=grade.id).update(is_fully_confirmed=False,pending_max_score=Decimal('9.99'))
    history=GradeEvent.objects.create(attempt=attempt,grading_revision=2,is_superseded=True,status='confirmed',max_score=grade.max_score,confirmed_score=grade.confirmed_score,pending_max_score=Decimal('9.99'),is_fully_confirmed=False,parts=grade.parts)
    call_command('audit_projection_semantics',apply=True)
    grade.refresh_from_db();history.refresh_from_db()
    audit=ContentRevision.objects.get(entity_id=str(grade.id),action='projection_semantics_rewrite')
    assert grade.is_fully_confirmed and grade.pending_max_score==0
    assert history.pending_max_score==Decimal('9.99') and not history.is_fully_confirmed
    assert not ContentRevision.objects.filter(entity_id=str(history.id),action='projection_semantics_rewrite').exists()
    assert audit.detail['before']['pending_max_score']=='9.99'
    assert audit.detail['after']['pending_max_score']=='0'
    assert audit.detail['batch_id'] and audit.before_digest != audit.after_digest
