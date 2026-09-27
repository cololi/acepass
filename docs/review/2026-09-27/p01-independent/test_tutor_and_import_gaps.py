import pytest
from tests.integration.test_practice_flow import present, published, start_session
pytest_plugins = ['tests.conftest']
pytestmark = pytest.mark.django_db

def test_parallel_practice_tutor_gate(caller, project_a, subject_a1):
    version=published(subject_a1, 'true_false')
    verify=start_session(caller,project_a,subject_a1,version.question,mode='verification',key='audit-verify')
    present(caller,project_a,verify['items'][0]['session_item_id'])
    practice=start_session(caller,project_a,subject_a1,version.question,mode='practice',key='audit-practice')
    item=practice['items'][0]['session_item_id']
    opened=caller.post(f'/api/v1/projects/{project_a.id}/tutor-sessions',{'session_item_id':item,'purpose':'explanation'},key='audit-tutor')
    print('parallel tutor session:',opened.status_code)
    if opened.status_code == 201:
        session=opened.json()['tutor_session_id']
        response=caller.post(f'/api/v1/projects/{project_a.id}/tutor-sessions/{session}/messages',{'user_question':'请讲解这道题'},key='audit-message')
        print('parallel tutor job:',response.status_code,response.json())
    assert opened.status_code == 403, opened.content

def test_late_extraction_must_not_overwrite_human_review(project_a, subject_a1):
    import io
    from PIL import Image
    from ai.providers.base import AiCallResult
    from apps.ingestion.services.core import create_image_document, update_candidate
    from apps.ingestion.services.imports import start_image_import
    from apps.ingestion.services.extraction import _apply_extraction
    buffer=io.BytesIO(); Image.new('RGB',(8,8),'white').save(buffer,format='PNG')
    document=create_image_document(owner=project_a.owner,project=project_a,content=buffer.getvalue(),content_type='image/png',subject=subject_a1)
    job=start_image_import(owner=project_a.owner,project=project_a,documents=[document],subject=subject_a1,use_vision=False)
    candidate=job.candidates.get()
    edited={**candidate.draft_payload, 'question_type':'true_false','content':{'blocks':[{'kind':'text','text':'HUMAN_REVIEW_MARKER'}]},'answer_payload':{'kind':'true_false','value':True},'answer_status_known':True}
    update_candidate(candidate,payload=edited,actor=project_a.owner,expected_revision=candidate.revision)
    stale={'question_type':'true_false','content':{'blocks':[{'kind':'text','text':'STALE_MODEL_OUTPUT'}]},'answer_payload':{},'answer_status_known':False}
    _apply_extraction(candidate=candidate,clean=stale,call=AiCallResult(payload=stale,is_stub=True),problems=[])
    candidate.refresh_from_db()
    print('late extraction resulting payload',candidate.draft_payload)
    assert candidate.draft_payload['content']['blocks'][0]['text']=='HUMAN_REVIEW_MARKER'
