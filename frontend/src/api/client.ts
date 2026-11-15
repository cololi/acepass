/**
 * Typed API client — compatibility barrel.
 *
 * The implementation lives in one module per domain (`transport`, `knowledge`,
 * `practice`, …) plus type-only modules under `types/`. This file used to hold
 * all 2,932 lines in one place; it stays as the single import path so the 23
 * call sites keep compiling unchanged, and so the split could be reviewed as
 * a pure move rather than a rewrite.
 *
 * Nothing may import from *this* file: domain modules import `./transport`,
 * `./errors` and `./types/*` directly. Adding `export *` here would rebuild the
 * god module and undo the entry-chunk saving the split buys.
 */

export { ApiError, apiRequest, ensureCsrf, newIdempotencyKey } from './transport'
export type { ApiErrorBody } from './transport'
export type { AiStatus, AttemptDetail, AttemptState, Block, EvidenceRow, GradeOut, GradePart, KnowledgeStateRow, MistakeRow, PlanTaskOut, PresentationOut, ProjectOut, QuestionListItem, RevealOut, SessionItemState, SessionOut, SpecOut, StemPayload, SubjectOut, SyllabusOut, TodayPlanOut, TutorJobOut, UploadedAsset, UserOut } from './types/study'
export type { AiRunRow, CandidateOut, CycleAnalysisOut, GradingQueueRow, ImportJobOut, KnowledgeNode, KnowledgeRelationEdge, KnowledgeRelationGraph, NodePrerequisiteRow, NodePrerequisitesOut, OutlineImportOut, PaperOut, PaperRevisionOut, ReportAggregateOut, ReportBucketOut, ReportFinalResultOut, ReportFractionStatus, ReportIncompleteReasonOut, ReportIncompleteScopeOut, ReportOut, ReviewTaskRow, VerificationPairingOut } from './types/records'
export { acceptTagSuggestion, createKnowledgeRelation, createTagSuggestion, cycleNamesOf, deactivateKnowledgeRelation, fetchKnowledgeRelations, fetchNodePrerequisites, fetchTagSuggestions, rejectTagSuggestion } from './knowledge'
export type { TagMappingRow, TagProposal, TagSuggestionDecisionOut, TagSuggestionOut } from './knowledge'
export { fetchSearchResults, reindexSearch, searchChannelReason } from './search'
export type { SearchChannelStatus, SearchReindexOut, SearchResponseOut, SearchResultRow } from './search'
export { createMemoryCard, fetchMemoryCardLogs, fetchMemoryCards, rebuildMemoryCard, resumeMemoryCard, reviewMemoryCard, suspendMemoryCard } from './memory'
export type { MemoryCardOut, MemoryRating, MemoryRebuildOut, MemoryReviewLogOut, MemoryReviewOut } from './memory'
export { answerDiagnosisFollowUp, confirmTranscription, fetchAiEstimate, fetchTranscriptions, fetchTutorSegments, missingAssetIdsOf, normalizeAiDiagnosis, normalizeAiEstimate, normalizeDiagnosisOut, normalizeTranscriptionList, normalizeTutorSegment, normalizeTutorSegments, rejectTranscription, requestAiDiagnosis, requestAiEstimate, requestTranscription, setAttemptDiagnosis, skipDiagnosisFollowUp, tutorStreamUrl } from './ai-assist'
export type { AiDiagnosisOut, AiEstimateCriterion, AiEstimateOut, DiagnosisCause, DiagnosisFollowUp, DiagnosisOut, TranscriptionListOut, TranscriptionOut, TutorSegmentOut, TutorSegmentsOut } from './ai-assist'
export { LAYOUT_BLOCKING_ISSUE_CODES, LAYOUT_WARNING_ISSUE_CODES, confirmCandidateLayout, fetchImportJob, isLayoutBlockingIssue, isLayoutIssue, issuePageIndexes, problemsOf } from './imports'
export type { ApiProblemRow, PageDiagnosticOut, ReviewIssueOut } from './imports'
export { declareQuestionExternalSeen, fetchQuestionExposure, normalizeExposureState, serverMessageOf } from './exposure'
export type { ContaminationEvidenceOut, ExclusionReasonOut, QuestionExposureOut } from './exposure'
export { addQuestionToFamily, createQuestionFamily, fetchFamilyMergeImpact, fetchQuestionFamilies, fetchSealedContent, mergeQuestionFamily, normalizeSealedContent, patchQuestionFamily, removeQuestionFromFamily, sealQuestion, sealQuestionFamily, unsealQuestion, unsealQuestionFamily } from './questions'
export type { FamilyMergeExposureChange, FamilyMergeImpactOut, FamilyMergeOut, FamilyQuestionOut, QuestionFamilyOut, SealOut, SealedContentFamilyRow, SealedContentOut, SealedContentQuestionRow } from './questions'
export { fetchVariantJobs, proposeVariants } from './variants'
export type { VariantCandidateOut, VariantIssueOut, VariantJobOut, VariantListOut, VariantProposeOut, VariantValidationOut } from './variants'
export { createExamClock, createMockExamSession, deadlineLabel, examDeadlineRefusalOf, fetchPublishedQuestions, finishPracticeSession, formatRemaining } from './practice'
export type { ExamClock, ExamClockPayload, ExamDeadlineRefusal, MockExamCreateIn } from './practice'
export { describeApiError } from './errors'
export { EXPRESSION_REVIEW_CODE_LABELS, bucketIsFinal, expressionReviewNotices, expressionReviewNoticesFromParts, fetchEffectCalibration, percentOfFraction } from './reports'
export type { CalibrationComparisonOut, CalibrationDeltaOut, CalibrationDimensionsOut, CalibrationExclusionReasonOut, CalibrationGroupOut, CalibrationOut, CalibrationStatisticsOut, CalibrationStatus, CoverageCompletionOut, CoverageCompletionReasonOut, ExpressionReviewNotice } from './reports'
