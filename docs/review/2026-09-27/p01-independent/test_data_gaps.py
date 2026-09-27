from datetime import timedelta
import pytest
from django.utils import timezone
from apps.analytics.services.reports import request_regrade, execute_regrade_run
from apps.learning.models import StudyTask
from apps.learning.services import pairing as pairing_services
from apps.learning.services.evidence import compute_dimensions
from apps.practice.models import Attempt
from apps.practice.services import attempts as attempt_services
from apps.practice.services import sessions as session_services
from apps.question_bank.models import AnswerKeyVersion
from apps.question_bank.services import core as content_services
from tests.integration.test_learning_loop import answer_for, make_pairing
from tests.integration.test_practice_flow import present, published, start_session, submit

pytest_plugins = ['tests.conftest']
pytestmark = pytest.mark.django_db

def make_service_attempt(project, subject, version, delivered, submitted):
    session = session_services.create_session(user=project.owner, project=project, subject=subject,
        question_ids=[str(version.question_id)])
    item = session.items.get()
    session_services.presentation(item=item, user=project.owner, now=delivered)
    attempt, grade = attempt_services.submit_attempt(session_item_id=str(item.id), user=project.owner,
        raw_answer=answer_for(version), now=submitted)
    return item, attempt

@pytest.mark.django_db(transaction=True)
def test_regrade_http_works_without_test_wrapping_transaction(caller, project_a, subject_a1):
    version = published(subject_a1, 'true_false')
    answer = AnswerKeyVersion.objects.get(question_version=version)
    response = caller.post(f'/api/v1/projects/{project_a.id}/regrades', {
        'question_id': str(version.question_id), 'target_answer_key_version_id': str(answer.id),
        'reason': 'independent API autocommit acceptance'}, key='audit-regrade-autocommit')
    print('regrade HTTP', response.status_code, response.content.decode())
    assert response.status_code == 201

def test_parallel_practice_submit_cannot_reveal_live_verification_score(caller, project_a, subject_a1):
    version = published(subject_a1, 'true_false')
    verification = start_session(caller, project_a, subject_a1, version.question, mode='verification')
    present(caller, project_a, verification['items'][0]['session_item_id'])
    practice = start_session(caller, project_a, subject_a1, version.question)
    item_id = practice['items'][0]['session_item_id']
    present(caller, project_a, item_id)
    response = submit(caller, project_a, item_id, {'type': 'true_false', 'value': True}, key='parallel-grade')
    print('parallel practice submit', response.status_code, response.json().get('grade'))
    assert response.status_code == 403 or response.json().get('grade') is None

def test_delayed_task_rechecks_latest_training_at_direct_session_start(caller, project_a, subject_a1):
    pair, a, b, _c = make_pairing(subject_a1)
    for version in (a, b, _c):
        content_services.replace_knowledge_mappings(version, [{'node_id': str(pair.node_id), 'is_primary': True, 'score_weight': '1'}], actor=project_a.owner)
    now = timezone.now()
    old = now - timedelta(hours=26)
    item_b, attempt_b = make_service_attempt(project_a, subject_a1, b, old-timedelta(minutes=1), old)
    pairing_services.on_attempt_graded(str(attempt_b.id))
    task = StudyTask.objects.get(pairing=pair, origin_session_item=item_b, task_kind='delayed_verification')
    assert task.not_before < now
    _item_a, attempt_a = make_service_attempt(project_a, subject_a1, a, now-timedelta(minutes=2), now-timedelta(minutes=1))
    response = caller.post(f'/api/v1/projects/{project_a.id}/practice-sessions', {
        'mode': 'verification', 'subject_id': str(subject_a1.id), 'task_id': str(task.id)}, key='latest-anchor')
    print('old deadline', task.not_before, 'latest training', attempt_a.submitted_at, 'start HTTP', response.status_code)
    assert response.status_code in {400,403,409}

def test_delayed_evidence_uses_completion_not_start_of_last_training(project_a, subject_a1):
    pair, _a, b, c = make_pairing(subject_a1)
    for version in (b, c):
        content_services.replace_knowledge_mappings(version, [{'node_id': str(pair.node_id), 'is_primary': True, 'score_weight': '1'}], actor=project_a.owner)
    now = timezone.now()
    make_service_attempt(project_a, subject_a1, b, now-timedelta(hours=25), now-timedelta(hours=1))
    _item_c, attempt_c = make_service_attempt(project_a, subject_a1, c, now-timedelta(minutes=1), now)
    dimension = next(x for x in compute_dimensions(attempt_c)
        if x['dimension']=='delayed_verification' and x['node'].id==pair.node_id)
    print('delay evidence', dimension)
    assert dimension['qualifies'] is False

def test_target_disputed_between_regrade_request_and_execution_is_refused(caller, project_a, subject_a1):
    version = published(subject_a1, 'true_false')
    now=timezone.now()
    item, attempt = make_service_attempt(project_a, subject_a1, version, now-timedelta(minutes=1), now)
    target = AnswerKeyVersion.objects.create(question_version=version, version=2,
        answer_payload=item.answer_key_version.answer_payload, verification_status='checked', checked_by=project_a.owner)
    run=request_regrade(question=version.question, target_answer_key_version=target,
        actor=project_a.owner, reason='queued before dispute')
    content_services.dispute_answer_key_version(target, actor=project_a.owner, reason='new evidence target wrong')
    execute_regrade_run(str(run.id))
    attempt.refresh_from_db()
    print('disputed target result', attempt.current_grade_event.status, attempt.current_grade_event.confirmed_score,
        attempt.current_grade_event.answer_key_version.is_disputed)
    assert attempt.current_grade_event.status != 'confirmed'

@pytest.mark.django_db(transaction=True)
def test_concurrent_regrade_requests_receive_distinct_generations(project_a, subject_a1, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    from django.db import transaction, connections
    from apps.analytics.models import RegradeRun
    from apps.question_bank.models import Question
    from apps.accounts.models import User
    version = published(subject_a1, 'true_false')
    answer = AnswerKeyVersion.objects.get(question_version=version)
    with transaction.atomic():
        seed = request_regrade(question=version.question, target_answer_key_version=answer,
            actor=project_a.owner, reason='seed generation')
    barrier = Barrier(2, timeout=10)
    original_create = RegradeRun.objects.create
    def synchronized_create(*args, **kwargs):
        result = original_create(*args, **kwargs)
        barrier.wait()
        return result
    monkeypatch.setattr(RegradeRun.objects, 'create', synchronized_create)
    def launch(i):
        try:
            with transaction.atomic():
                run = request_regrade(question=Question.objects.get(id=version.question_id),
                    target_answer_key_version=AnswerKeyVersion.objects.get(id=answer.id),
                    actor=User.objects.get(id=project_a.owner_id), reason=f'concurrent {i}')
                return run.generation
        finally:
            connections.close_all()
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(launch, i) for i in range(2)]
        generations = [f.result(timeout=20) for f in futures]
    print('concurrent generations', seed.generation, generations)
    assert len(set(generations)) == 2
