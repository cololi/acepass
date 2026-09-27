import pytest
from tests.integration.test_practice_flow import published, start_session, present, submit
pytest_plugins = ['tests.conftest']
pytestmark = pytest.mark.django_db


def test_finished_session_replay_rechecks_current_verification_gate(caller, project_a, subject_a1):
    version = published(subject_a1, 'true_false')
    practice = start_session(caller, project_a, subject_a1, version.question, key='finished-practice')
    item_id = practice['items'][0]['session_item_id']
    present(caller, project_a, item_id)
    result = submit(caller, project_a, item_id, {'type': 'true_false', 'value': True}, key='answer')
    assert result.status_code == 200
    finish_url = f"/api/v1/projects/{project_a.id}/practice-sessions/{practice['session_id']}/finish"
    finished = caller.post(finish_url, {}, key='finish-practice')
    assert finished.status_code == 200
    assert finished.json()['confirmed_score'] is not None
    verification = start_session(caller, project_a, subject_a1, version.question, mode='verification', key='verify')
    present(caller, project_a, verification['items'][0]['session_item_id'])
    current = caller.get(f"/api/v1/projects/{project_a.id}/practice-sessions/{practice['session_id']}")
    assert current.status_code == 200
    assert current.json()['confirmed_score'] is None
    assert current.json()['items'][0]['attempt']['grade'] is None
    replay = caller.post(finish_url, {}, key='finish-practice')
    print('FINISH_INITIAL_STATUS', finished.status_code, 'FINISH_INITIAL_BODY', finished.json())
    print('CURRENT_GET_STATUS', current.status_code, 'CURRENT_GET_BODY', current.json())
    print('FINISH_REPLAY_STATUS', replay.status_code, 'FINISH_REPLAY_BODY', replay.json())
    assert replay.status_code == 403 or (
        replay.json().get('confirmed_score') is None
        and replay.json()['items'][0]['attempt']['grade'] is None
    ), replay.json()
