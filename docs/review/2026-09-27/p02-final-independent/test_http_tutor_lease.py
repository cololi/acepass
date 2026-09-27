"""C04: real HTTP caller + actual leased task, deterministic provider interleaving.

The provider is stubbed; this does not claim OS concurrency or real AI evidence.
The HTTP handler runs in autocommit with ACEPASS_INLINE_TASKS=False, just like
production. While its provider is outstanding, a second actual leased task tries
to consume the committed event. A correct HTTP lease may make that second task
skip; the contract is one internally consistent final result, not two provider
calls. If HTTP is intentionally changed to asynchronous delivery, adapt the test
driver to execute/poll the queued task while retaining those final assertions.
No application source is modified.
"""
import json
import pytest
from django.db import connection
from ai.providers import base as providers
from apps.audit.models import OutboxEvent
from apps.audit.services import outbox
from apps.practice.models import ExposureEvent
from apps.tutoring.models import TutorJob, TutorTurn
from apps.tutoring.tasks import run_tutor_job

pytest_plugins = ['tests.conftest']

@pytest.mark.django_db(transaction=True)
def test_http_inline_must_not_overwrite_leased_worker_result(caller, project_a, practice_item, monkeypatch, settings):
    settings.ACEPASS_INLINE_TASKS = False
    # Broker transport is irrelevant to this deterministic interleaving. The
    # actual task below still claims and confirms the persisted outbox row.
    monkeypatch.setattr(outbox, 'after_commit_dispatch', lambda **kwargs: None)
    opened = caller.post(
        f'/api/v1/projects/{project_a.id}/tutor-sessions',
        {'session_item_id': str(practice_item.id), 'purpose': 'explanation'},
        key='review-inline-tutor-session',
    )
    assert opened.status_code == 201, opened.content
    tutor_id = opened.json()['tutor_session_id']
    calls = []
    seen = {}

    def interleaved_provider(provider, request, **kwargs):
        assert connection.get_autocommit() is True
        index = len(calls) + 1
        calls.append(index)
        if index == 1:
            job = TutorJob.objects.get(tutor_session_id=tutor_id)
            event = OutboxEvent.objects.get(dedupe_key=f'tutor-job:{job.id}')
            seen['before_worker'] = {'status': event.status, 'token_present': bool(event.claim_token)}
            verdict = run_tutor_job(outbox_event_id=str(event.id), **event.payload)
            seen['second_consumer_verdict'] = verdict
            job.refresh_from_db()
            event.refresh_from_db()
            seen['worker_result'] = job.result_blocks
            if verdict == 'succeeded':
                # The second consumer finished first: its finalized result wins.
                assert job.result_blocks[0]['text'] == 'leased-worker-result'
                assert event.status == 'processed' and event.processed_at is not None
                seen['expected_final_text'] = 'leased-worker-result'
            else:
                # Correct alternative: the HTTP caller owns the same claim, so
                # duplicate delivery does not invoke the provider at all.
                assert verdict == 'skipped_lease_not_held', verdict
                seen['expected_final_text'] = 'late-http-result'
        text = 'late-http-result' if index == 1 else 'leased-worker-result'
        body = {'explanation_blocks': [{'kind': 'text', 'text': text}],
                'citations': [], 'missing_information': [], 'suggested_next': []}
        return providers.AiCallResult(payload=body, raw_text=json.dumps(body), is_stub=True)

    monkeypatch.setattr(providers, 'call_with_deadline', interleaved_provider)
    response = caller.post(
        f'/api/v1/projects/{project_a.id}/tutor-sessions/{tutor_id}/messages',
        {'user_question': 'Explain this question'}, key='review-http-tutor-message',
    )
    assert response.status_code == 201, response.content
    job = TutorJob.objects.get(id=response.json()['tutor_job_id'])
    event = OutboxEvent.objects.get(dedupe_key=f'tutor-job:{job.id}')
    assistant_texts = list(TutorTurn.objects.filter(job=job, role='assistant').values_list('text', flat=True))
    exposures = ExposureEvent.objects.filter(detail__tutor_job_id=str(job.id)).count()
    seen.update({'provider_calls': len(calls), 'response_blocks': response.json()['result_blocks'],
                 'final_blocks': job.result_blocks, 'assistant_texts': assistant_texts,
                 'exposures': exposures, 'outbox_status': event.status,
                 'processed': event.processed_at is not None, 'finalized': job.finalized_at is not None})
    print(json.dumps(seen, ensure_ascii=False))
    assert len(assistant_texts) == 1 and exposures == 1
    assert event.status == 'processed' and event.processed_at is not None
    assert job.finalized_at is not None
    assert job.result_blocks[0]['text'] == assistant_texts[0] == seen['expected_final_text'], (
        'The final job, HTTP response and assistant message must preserve the result '
        'committed by the successful lease owner, without a stale caller overwrite'
    )
    assert response.json()['result_blocks'] == job.result_blocks
