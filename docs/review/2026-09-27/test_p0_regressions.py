from datetime import timedelta
from decimal import Decimal
import pytest
from django.utils import timezone
from apps.practice.models import Attempt, SessionItem
from apps.practice.services import attempts as attempt_services
from apps.practice.services import sessions as session_services
from apps.question_bank.models import AnswerKeyVersion
from apps.question_bank.services import core as content_services
from apps.analytics.services.reports import request_regrade, execute_regrade_run
from apps.learning.services import pairing as pairing_services
from apps.learning.models import StudyTask
from tests.integration.test_practice_flow import published, start_session, present, submit
from tests.integration.test_learning_loop import answer_for, make_pairing
pytest_plugins = ['tests.conftest']
pytestmark = pytest.mark.django_db

def make_attempt(caller, project, subject, kind='single_choice', mode='practice'):
    version = published(subject, kind)
    sess = start_session(caller, project, subject, version.question, mode=mode)
    item_id = sess['items'][0]['session_item_id']
    present(caller, project, item_id)
    response = submit(caller, project, item_id, answer_for(version), key='review-submit')
    assert response.status_code == 200, response.content
    return version, sess, SessionItem.objects.get(id=item_id), response.json()

def test_active_verification_never_serializes_score(caller, project_a, subject_a1):
    version, sess, item, res = make_attempt(caller, project_a, subject_a1, 'true_false', 'verification')
    assert res['receipt_only'] is True and res['grade'] is None
    state = caller.get(f'/api/v1/projects/{project_a.id}/practice-sessions/{sess["session_id"]}').json()
    report = caller.get(f'/api/v1/projects/{project_a.id}/reports/practice').json()
    print('VERIFICATION_LEAK', {'score_visible':state['score_visible'], 'confirmed_score':state['confirmed_score'], 'report':report['totals']['fully_confirmed']})
    assert state.get('confirmed_score') is None and state.get('pending_max_score') is None

def test_all_manual_parts_confirmed_partial_score_is_final(caller, project_a, subject_a1):
    v, sess, item, res = make_attempt(caller, project_a, subject_a1, 'constructed_response')
    criteria = item.rubric_version.criteria
    parts = [{'part_id': c['criterion_id'], 'score': str(Decimal(c['max_score']))} for c in criteria]
    parts[0]['score'] = '0'
    result = caller.post(f'/api/v1/projects/{project_a.id}/attempts/{res["attempt_id"]}/confirm-grade', {'expected_grading_revision':res['grading_revision'], 'answer_key_version_id':str(item.answer_key_version_id), 'rubric_version_id':str(item.rubric_version_id), 'parts':parts}).json()
    print('MANUAL_PARTIAL', {k:result[k] for k in ['status','confirmed_score','max_score','pending_max_score','is_fully_confirmed']}, result['parts'])
    assert result['status'] == 'confirmed' and Decimal(result['pending_max_score']) == 0

def test_dispute_before_submit_must_not_use_disputed_key(caller, project_a, subject_a1):
    v = published(subject_a1, 'single_choice')
    answer = answer_for(v)
    sess = start_session(caller, project_a, subject_a1, v.question)
    item_id = sess['items'][0]['session_item_id']
    present(caller, project_a, item_id)
    key = AnswerKeyVersion.objects.get(question_version=v)
    content_services.dispute_answer_key_version(key, actor=project_a.owner, reason='review dispute before submit')
    result = submit(caller, project_a, item_id, answer, key='after-dispute').json()
    print('DISPUTED_SUBMISSION', result['grade'])
    assert result['grade']['status'] == 'pending_review'

def test_older_regrade_late_completion_cannot_override_newer(caller, project_a, subject_a1):
    v, sess, item, res = make_attempt(caller, project_a, subject_a1)
    original = item.answer_key_version
    good = original.answer_payload['correct_option_id']
    bad = next(o['id'] for o in v.content['options'] if o['id'] != good)
    key2 = AnswerKeyVersion.objects.create(question_version=v, version=2, answer_payload={'correct_option_id':bad}, verification_status='checked', checked_by=project_a.owner)
    key3 = AnswerKeyVersion.objects.create(question_version=v, version=3, answer_payload={'correct_option_id':good}, verification_status='checked', checked_by=project_a.owner)
    old = request_regrade(question=v.question, target_answer_key_version=key2, actor=project_a.owner, reason='older requested target')
    new = request_regrade(question=v.question, target_answer_key_version=key3, actor=project_a.owner, reason='newer requested target')
    execute_regrade_run(str(new.id))
    execute_regrade_run(str(old.id))
    attempt = Attempt.objects.get(id=res['attempt_id'])
    print('LATE_OLD_REGRADE', {'effective_key_version':attempt.current_grade_event.answer_key_version.version, 'score':str(attempt.current_grade_event.confirmed_score), 'revision':attempt.grading_revision})
    assert attempt.current_grade_event.answer_key_version_id == key3.id

def test_pairing_c_waits_24h_from_b_submission(caller, project_a, subject_a1):
    pair, a, b, c = make_pairing(subject_a1)
    t_b = timezone.now()
    t_a = t_b - timedelta(hours=25)
    sa = session_services.create_session(user=project_a.owner, project=project_a, subject=subject_a1, question_ids=[str(a.question_id)])
    ia = sa.items.get()
    session_services.presentation(item=ia,user=project_a.owner, now=t_a-timedelta(minutes=1))
    aa, ga = attempt_services.submit_attempt(session_item_id=str(ia.id), user=project_a.owner, raw_answer=answer_for(a), now=t_a)
    sb = session_services.create_session(user=project_a.owner, project=project_a, subject=subject_a1, question_ids=[str(b.question_id)])
    ib = sb.items.get()
    session_services.presentation(item=ib,user=project_a.owner, now=t_b-timedelta(minutes=1))
    ab, gb = attempt_services.submit_attempt(session_item_id=str(ib.id), user=project_a.owner, raw_answer=answer_for(b), now=t_b)
    pairing_services.on_attempt_graded(str(ab.id))
    task = StudyTask.objects.get(pairing=pair, origin_session_item=ib, task_kind='delayed_verification')
    print('PAIR_DELAY', {'hours_after_b':(task.not_before-t_b).total_seconds()/3600, 'anchor':task.delay_anchor_at.isoformat()})
    assert task.not_before >= t_b+timedelta(hours=24)

def test_parallel_practice_cannot_reveal_active_verification(caller, project_a, subject_a1):
    v = published(subject_a1, 'true_false')
    verify = start_session(caller, project_a, subject_a1, v.question, mode='verification', key='active-verify')
    present(caller, project_a, verify['items'][0]['session_item_id'])
    practice = start_session(caller, project_a, subject_a1, v.question, mode='practice', key='parallel-practice')
    item_id = practice['items'][0]['session_item_id']
    result = caller.post(f'/api/v1/projects/{project_a.id}/session-items/{item_id}/reveal')
    print('PARALLEL_REVEAL', {'http_status':result.status_code, 'answer_payload':result.json().get('answer_payload')})
    assert result.status_code == 403

def test_zero_score_is_not_independent_correct(caller, project_a, subject_a1):
    from apps.learning.services.evidence import compute_dimensions
    v = published(subject_a1, 'true_false')
    sess = start_session(caller, project_a, subject_a1, v.question)
    item_id = sess['items'][0]['session_item_id']
    present(caller, project_a, item_id)
    wrong = {'type':'true_false','value':not answer_for(v)['value']}
    result = submit(caller, project_a, item_id, wrong, key='wrong-check').json()
    attempt = Attempt.objects.get(id=result['attempt_id'])
    row = next(x for x in compute_dimensions(attempt) if x['dimension'] == 'independent_correct')
    print('ZERO_SCORE_CHECK', {'score':result['grade']['confirmed_score'], 'status':result['grade']['status'], 'fully':result['grade']['is_fully_confirmed'], 'independent_qualifies':row['qualifies'], 'independent_correct':row['is_correct']})
    assert Decimal(result['grade']['confirmed_score']) == 0
    assert not row['qualifies'] and not row['is_correct']

def test_task_session_creation_cannot_bypass_delay(caller, project_a, subject_a1):
    pair, a, b, c = make_pairing(subject_a1)
    sess = start_session(caller, project_a, subject_a1, b.question)
    item_id = sess['items'][0]['session_item_id']
    present(caller, project_a, item_id)
    submitted = submit(caller, project_a, item_id, answer_for(b), key='b-now')
    assert submitted.status_code == 200
    task = StudyTask.objects.get(pairing=pair, origin_session_item_id=item_id, task_kind='delayed_verification')
    assert task.not_before > timezone.now()+timedelta(hours=23)
    response = caller.post(f'/api/v1/projects/{project_a.id}/practice-sessions', {'mode':'verification', 'subject_id':str(subject_a1.id), 'task_id':str(task.id)}, key='bypass-delay')
    task.refresh_from_db()
    print('DIRECT_TASK_DELAY_BYPASS', {'status':response.status_code,'task_status':task.status,'due_future':task.not_before.isoformat()})
    assert response.status_code in (400, 403, 409)

def test_image_import_accepts_browser_multipart(caller, project_a, subject_a1, monkeypatch):
    from io import BytesIO
    from PIL import Image
    from django.core.files.uploadedfile import SimpleUploadedFile
    from ai.providers import base as providers
    from apps.audit.models import LLMRun
    seen = []
    provider = providers.StubProvider()
    original_call = provider.call
    def record(request):
        seen.append(request.capability)
        return original_call(request)
    monkeypatch.setattr(provider, 'call', record)
    providers.set_provider_override(provider)
    image = BytesIO()
    Image.new('RGB', (16, 16), 'white').save(image, format='PNG')
    response = caller.client.post(
        f'/api/v1/projects/{project_a.id}/imports/images',
        data={'subject_id':str(subject_a1.id), 'files':[SimpleUploadedFile('review.png', image.getvalue(), content_type='image/png')]},
        HTTP_X_CSRFTOKEN=caller.client.cookies['csrftoken'].value,
        HTTP_IDEMPOTENCY_KEY='review-vision-import',
    )
    assert response.status_code == 201, response.content
    print('VISION_NOT_WIRED', {'capability_available':provider.supports('extract_question'), 'called':seen, 'input_kind':response.json()['input_kind'], 'extract_runs':LLMRun.objects.filter(capability='extract_question').count()})
    # Provider execution is checked separately below, after transport acceptance.

def test_personalized_prompt_contains_actual_answer_and_steps(caller, project_a, subject_a1):
    from apps.tutoring.services.core import build_prompt
    version = published(subject_a1, 'constructed_response')
    session = start_session(caller, project_a, subject_a1, version.question)
    item_id = session['items'][0]['session_item_id']
    present(caller, project_a, item_id)
    raw_marker = 'REVIEW_ORIGINAL_ANSWER_5_times_4_equals_20'
    step_marker = 'REVIEW_STUDENT_STEP_counted_order_twice'
    response = caller.post(
        f'/api/v1/projects/{project_a.id}/session-items/{item_id}/submit',
        {'answer':{'type':'constructed_response','text':raw_marker}, 'steps':[{'text':step_marker}], 'confidence':'unsure'},
        key='review-real-answer-context',
    )
    assert response.status_code == 200, response.content
    prompt = build_prompt(item=SessionItem.objects.get(id=item_id))
    print('TUTOR_CONTEXT', {'raw_answer_in_prompt':raw_marker in prompt, 'steps_in_prompt':step_marker in prompt})
    assert raw_marker in prompt and step_marker in prompt, 'Only grading statuses are passed; actual student work is absent'

@pytest.mark.parametrize('endpoint',['learning-states','evidence','review-tasks'])
def test_project_learning_routes_match_frontend(caller, project_a, endpoint):
    response = caller.get(f'/api/v1/projects/{project_a.id}/{endpoint}')
    print('LEARNING_ROUTE', endpoint, response.status_code)
    assert response.status_code == 200


def test_image_service_invokes_configured_vision_provider(project_a, subject_a1, monkeypatch):
    from io import BytesIO
    from PIL import Image
    from ai.providers import base as providers
    from apps.ingestion.services.core import create_image_document
    from apps.ingestion.services.imports import start_image_import
    from apps.audit.models import LLMRun
    seen=[]
    provider=providers.StubProvider()
    original=provider.call
    def record(request):
        seen.append(request.capability)
        return original(request)
    monkeypatch.setattr(provider,'call',record)
    providers.set_provider_override(provider)
    picture=BytesIO()
    Image.new('RGB',(16,16),'white').save(picture,format='PNG')
    document=create_image_document(owner=project_a.owner, project=project_a, content=picture.getvalue(), content_type='image/png', subject=subject_a1)
    job=start_image_import(owner=project_a.owner, project=project_a, documents=[document], subject=subject_a1)
    print('VISION_SERVICE_NOT_WIRED', {'supports':provider.supports('extract_question'), 'calls':seen, 'input_kind':job.input_kind, 'extract_runs':LLMRun.objects.filter(capability='extract_question').count()})
    assert 'extract_question' in seen
