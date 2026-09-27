import pytest
from tests.integration.test_practice_flow import present, published, start_session, submit
from apps.learning.services.evidence import rebuild_for_attempt

pytest_plugins = ['tests.conftest']
pytestmark = pytest.mark.django_db


def prepared(caller, project, subject, qtype='true_false', answer=None):
    version = published(subject, qtype)
    practice = start_session(caller, project, subject, version.question, key='before-practice')
    item_id = practice['items'][0]['session_item_id']
    present(caller, project, item_id)
    answer = answer or {'type':'true_false', 'value':True}
    result = submit(caller, project, item_id, answer, key='before-submit')
    assert result.status_code == 200, result.content
    verification = start_session(caller, project, subject, version.question, mode='verification', key='after-verification')
    present(caller, project, verification['items'][0]['session_item_id'])
    return practice, item_id, result.json(), answer


def test_existing_parallel_session_must_hide_score(caller, project_a, subject_a1):
    practice, item_id, submitted, _ = prepared(caller, project_a, subject_a1)
    assert caller.get(f'/api/v1/projects/{project_a.id}/attempts/{submitted["attempt_id"]}').status_code == 403
    response = caller.get(f'/api/v1/projects/{project_a.id}/practice-sessions/{practice["session_id"]}')
    payload = response.json()
    assert response.status_code == 403 or (payload.get('confirmed_score') is None and payload['items'][0]['attempt']['grade'] is None), payload


def test_idempotent_submit_must_recheck_gate(caller, project_a, subject_a1):
    _, item_id, _, answer = prepared(caller, project_a, subject_a1)
    result = submit(caller, project_a, item_id, answer, key='before-submit')
    assert result.status_code == 403 or result.json().get('grade') is None, result.json()


def test_evidence_of_parallel_attempt_must_be_hidden(caller, project_a, subject_a1):
    _, _, submitted, _ = prepared(caller, project_a, subject_a1)
    rebuild_for_attempt(submitted['attempt_id'])
    response = caller.get(f'/api/v1/projects/{project_a.id}/evidence')
    assert response.status_code == 200
    leaked = [r for r in response.json()['rows'] if r['attempt_id'] == submitted['attempt_id']]
    assert not leaked, leaked


def test_pending_parallel_grade_queue_must_hide_score_and_rubric(caller, project_a, subject_a1):
    _, _, submitted, _ = prepared(caller, project_a, subject_a1, qtype='constructed_response', answer={'type':'constructed_response', 'text':'my work'})
    response = caller.get(f'/api/v1/projects/{project_a.id}/grading-queue')
    assert response.status_code == 200
    leaked = [r for r in response.json() if r['attempt_id'] == submitted['attempt_id']]
    assert not leaked, leaked


def test_idempotent_tutor_message_must_recheck_gate(caller, project_a, subject_a1):
    version = published(subject_a1, 'true_false')
    practice = start_session(caller, project_a, subject_a1, version.question, key='tutor-practice')
    item_id = practice['items'][0]['session_item_id']
    present(caller, project_a, item_id)
    opened = caller.post(f'/api/v1/projects/{project_a.id}/tutor-sessions', {'session_item_id':item_id,'purpose':'explanation'}, key='tutor-open')
    assert opened.status_code == 201
    tutor_id = opened.json()['tutor_session_id']
    url = f'/api/v1/projects/{project_a.id}/tutor-sessions/{tutor_id}/messages'
    body = {'user_question':'请讲解此题'}
    asked = caller.post(url, body, key='tutor-message')
    assert asked.status_code == 201 and asked.json()['result_blocks'], asked.content
    verification = start_session(caller, project_a, subject_a1, version.question, mode='verification', key='tutor-verification')
    present(caller, project_a, verification['items'][0]['session_item_id'])
    assert caller.get(f'/api/v1/projects/{project_a.id}/tutor-jobs/{asked.json()["tutor_job_id"]}').status_code == 403
    replay = caller.post(url, body, key='tutor-message')
    assert replay.status_code == 403 or not replay.json().get('result_blocks'), replay.json()
