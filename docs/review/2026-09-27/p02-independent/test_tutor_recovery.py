from datetime import timedelta
import pytest
from django.utils import timezone
from apps.audit.models import OutboxEvent
from apps.common.enums import OutboxStatus
from apps.practice.models import ExposureEvent
from apps.tutoring.models import TutorSession, TutorTurn
from apps.tutoring.services import core
from apps.tutoring.tasks import run_tutor_job
pytest_plugins=['tests.conftest']

@pytest.mark.django_db(transaction=True)
def test_tutor_retry_after_success_save_restores_exposure(practice_item, monkeypatch):
    item=practice_item
    tutor=TutorSession.objects.create(user=item.session.user,project=item.session.project,practice_session=item.session,session_item=item,purpose='explanation',question_version=item.question_version,answer_key_version=item.answer_key_version,rubric_version=item.rubric_version)
    job=core.create_job(tutor_session=tutor,user=item.session.user,user_question='解释本题')
    event=OutboxEvent.objects.get(dedupe_key=f'tutor-job:{job.id}')
    original_create=TutorTurn.objects.create
    def crash_before_turn(**kwargs):
        raise SystemExit('deterministic crash after job succeeded before exposure')
    monkeypatch.setattr(TutorTurn.objects,'create',crash_before_turn)
    with pytest.raises(SystemExit):
        run_tutor_job(outbox_event_id=str(event.id),**event.payload)
    event.refresh_from_db(); job.refresh_from_db()
    assert event.status==OutboxStatus.PROCESSING
    assert job.status=='succeeded'
    assert not ExposureEvent.objects.filter(detail__tutor_job_id=str(job.id)).exists()
    monkeypatch.setattr(TutorTurn.objects,'create',original_create)
    OutboxEvent.objects.filter(id=event.id).update(lease_expires_at=timezone.now()-timedelta(seconds=1))
    result=run_tutor_job(outbox_event_id=str(event.id),**event.payload)
    event.refresh_from_db()
    print({'retry_result':result,'outbox_status':event.status,'processed':event.processed_at is not None,'job_status':job.status,'assistant_turns':TutorTurn.objects.filter(job=job,role='assistant').count(),'exposures':ExposureEvent.objects.filter(detail__tutor_job_id=str(job.id)).count()})
    assert ExposureEvent.objects.filter(detail__tutor_job_id=str(job.id)).count()==1, '成功且可读的讲解必须在崩溃重投后保留曝光事实'

@pytest.mark.django_db(transaction=True)
def test_stale_tutor_consumer_cannot_overwrite_after_lease_takeover(practice_item, monkeypatch):
    import json
    from ai.providers import base as providers
    item=practice_item
    tutor=TutorSession.objects.create(user=item.session.user,project=item.session.project,practice_session=item.session,session_item=item,purpose='explanation',question_version=item.question_version,answer_key_version=item.answer_key_version,rubric_version=item.rubric_version)
    job=core.create_job(tutor_session=tutor,user=item.session.user,user_question='解释本题')
    event=OutboxEvent.objects.get(dedupe_key=f'tutor-job:{job.id}')
    invocations=[]
    def call_with_takeover(provider, request, **kwargs):
        number=len(invocations)+1
        invocations.append(number)
        if number==1:
            # Deterministic lease expiry/takeover interleaving, not a real clock or process claim.
            OutboxEvent.objects.filter(id=event.id).update(lease_expires_at=timezone.now()-timedelta(seconds=1))
            run_tutor_job(outbox_event_id=str(event.id),**event.payload)
        payload={'explanation_blocks':[{'kind':'text','text':f'consumer-{number}'}],'citations':[], 'missing_information':[], 'suggested_next':[]}
        return providers.AiCallResult(payload=payload, raw_text=json.dumps(payload),is_stub=True)
    monkeypatch.setattr(providers,'call_with_deadline',call_with_takeover)
    run_tutor_job(outbox_event_id=str(event.id),**event.payload)
    job.refresh_from_db(); event.refresh_from_db()
    turns=TutorTurn.objects.filter(job=job,role='assistant').count()
    exposures=ExposureEvent.objects.filter(detail__tutor_job_id=str(job.id)).count()
    print({'provider_calls':len(invocations),'final_blocks':job.result_blocks,'outbox':event.status,'assistant_turns':turns,'exposures':exposures})
    assert job.result_blocks[0]['text']=='consumer-2', '过期消费者不得覆盖接管者已确认的结果'
    assert turns==1 and exposures==1
