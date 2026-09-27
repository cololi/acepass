from datetime import timedelta
import importlib
import pytest
from django.db import connection
from django.utils import timezone
from apps.analytics.models import RegradeRun
from apps.analytics.services.reports import request_regrade, execute_regrade_run
from apps.learning.services.evidence import compute_dimensions
from apps.practice.services import attempts as attempt_services
from apps.practice.services import sessions as session_services
from apps.question_bank.models import AnswerKeyVersion
from apps.question_bank.services import core as content_services
from tests.integration.test_learning_loop import answer_for, make_pairing
from tests.integration.test_practice_flow import published

pytest_plugins = ['tests.conftest']
pytestmark = pytest.mark.django_db


def make_attempt(project, subject, version, delivered, submitted):
    session = session_services.create_session(user=project.owner, project=project, subject=subject,
        question_ids=[str(version.question_id)])
    item = session.items.get()
    session_services.presentation(item=item, user=project.owner, now=delivered)
    attempt, _ = attempt_services.submit_attempt(session_item_id=str(item.id), user=project.owner,
        raw_answer=answer_for(version), now=submitted)
    return item, attempt


def new_key(version, number, value, owner):
    return AnswerKeyVersion.objects.create(question_version=version, version=number,
        answer_payload={'type': 'true_false', 'value': value}, verification_status='checked', checked_by=owner)


def test_delayed_credit_cannot_be_earned_by_opening_early_and_submitting_late(project_a, subject_a1):
    pair, _a, b, c = make_pairing(subject_a1)
    for version in (b,c):
        content_services.replace_knowledge_mappings(version,
            [{'node_id': str(pair.node_id), 'is_primary': True, 'score_weight': '1'}], actor=project_a.owner)
    now = timezone.now()
    make_attempt(project_a, subject_a1, b, now-timedelta(hours=25, minutes=1), now-timedelta(hours=25))
    item_c, attempt_c = make_attempt(project_a, subject_a1, c, now-timedelta(hours=2), now)
    dimension = next(d for d in compute_dimensions(attempt_c)
        if d['dimension']=='delayed_verification' and d['node'].id==pair.node_id)
    print('EARLY_C', {'B_to_C_first_present_hours': 23, 'B_to_C_submit_hours':25,
        'first_delivered_at':item_c.first_delivered_at.isoformat(), 'submitted_at':attempt_c.submitted_at.isoformat(),
        'qualifies':dimension['qualifies'], 'detail':dimension['detail'], 'reasons':dimension['exclusion_reasons']})
    assert dimension['qualifies'] is False


def test_old_disputed_regrade_cannot_invalidate_a_newer_trusted_grade(project_a, subject_a1):
    version = published(subject_a1, 'true_false')
    now = timezone.now()
    item, attempt = make_attempt(project_a, subject_a1, version, now-timedelta(minutes=1), now)
    original_value = item.answer_key_version.answer_payload['value']
    v2 = new_key(version,2,not original_value,project_a.owner)
    v3 = new_key(version,3,original_value,project_a.owner)
    old = request_regrade(question=version.question, target_answer_key_version=v2, actor=project_a.owner,reason='older queued target')
    new = request_regrade(question=version.question, target_answer_key_version=v3, actor=project_a.owner,reason='new valid target')
    execute_regrade_run(str(new.id))
    attempt.refresh_from_db()
    prior_id = attempt.current_grade_event_id
    assert attempt.current_grade_event.answer_key_version_id == v3.id
    content_services.dispute_answer_key_version(v2, actor=project_a.owner, reason='only obsolete v2 wrong')
    execute_regrade_run(str(old.id))
    attempt.refresh_from_db()
    print('STALE_DISPUTED', {'old_generation':old.generation, 'new_generation':new.generation,
        'watermark':attempt.applied_regrade_generation,'grade_status':attempt.current_grade_event.status,
        'current_answer_version':attempt.current_grade_event.answer_key_version.version,
        'current_key_disputed':attempt.current_grade_event.answer_key_version.is_disputed})
    assert attempt.current_grade_event_id == prior_id


def test_generation_migration_cannot_promote_old_queued_run_above_applied_newer_run(project_a, subject_a1):
    version = published(subject_a1, 'true_false')
    now = timezone.now()
    item, attempt = make_attempt(project_a, subject_a1, version, now-timedelta(minutes=1), now)
    original_value = item.answer_key_version.answer_payload['value']
    v2 = new_key(version,2,not original_value,project_a.owner)
    v3 = new_key(version,3,original_value,project_a.owner)
    # Reproduce reachable pre-0004 state: two concurrent gen=1 requests, followed
    # by gen=2 already applied. Drop only this constraint inside this test's
    # transaction; pytest rolls it and all fixture data back afterwards.
    with connection.cursor() as cursor:
        cursor.execute('ALTER TABLE analytics_regrade_run DROP CONSTRAINT uniq_regrade_question_generation')
    common = dict(user=project_a.owner, project=project_a, subject=subject_a1, question=version.question,requested_by=project_a.owner)
    seed = RegradeRun.objects.create(**common,target_answer_key_version=item.answer_key_version,generation=1,status='succeeded',reason='first old run')
    stale = RegradeRun.objects.create(**common,target_answer_key_version=v2,generation=1,reason='concurrent duplicate remains queued')
    latest = RegradeRun.objects.create(**common,target_answer_key_version=v3,generation=2,reason='latest valid request')
    execute_regrade_run(str(latest.id))
    attempt.refresh_from_db()
    assert attempt.applied_regrade_generation == 2
    assert attempt.current_grade_event.answer_key_version_id == v3.id
    mod = importlib.import_module('apps.analytics.migrations.0004_p0_2_regrade_generation_sequence')
    with connection.cursor() as cursor:
        cursor.execute('SET CONSTRAINTS ALL IMMEDIATE')
        for sql in (mod.CREATE_SEQUENCE, mod.SETVAL_TO_MAX, mod.RENUMBER_DUPLICATES, mod.SETVAL_AFTER_BACKFILL):
            cursor.execute(sql)
        cursor.execute('ALTER TABLE analytics_regrade_run ADD CONSTRAINT uniq_regrade_question_generation UNIQUE (question_id, generation)')
    stale.refresh_from_db()
    execute_regrade_run(str(stale.id))
    attempt.refresh_from_db()
    print('MIGRATED_OLD_RUN', {'old_generation_after_migration':stale.generation, 'latest_generation':latest.generation,
        'watermark':attempt.applied_regrade_generation,'current_answer_version':attempt.current_grade_event.answer_key_version.version,
        'score':str(attempt.current_grade_event.confirmed_score)})
    assert attempt.current_grade_event.answer_key_version_id == v3.id
