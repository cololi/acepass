/**
 * Shared seeding helpers for the B5 tests.
 *
 * Kept out of the test files because both variant and extraction cases need the same
 * syllabus/node scaffolding, and a second copy would drift from the schema's FK order.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Instant } from '../../src/domain/instant.ts'
import { insertRow } from '../../src/store/repository.ts'

export function insertSyllabusRow(
  db: DatabaseSync,
  options: { subjectId: string; status?: string; now: Instant },
): string {
  return String(
    insertRow(
      db,
      'exams_syllabus_version',
      {
        subject_id: options.subjectId,
        name: '数学大纲',
        version_label: '2026',
        applies_from: null,
        applies_to: null,
        source_document_id: null,
        is_user_provisional: false,
        review_status: 'draft',
        status: options.status ?? 'published',
        published_at: options.now,
        created_by_id: null,
      },
      { now: options.now },
    ).id,
  )
}

export function insertNodeRow(
  db: DatabaseSync,
  options: { syllabusId: string; name: string; now: Instant; parentId?: string | null },
): string {
  return String(
    insertRow(
      db,
      'knowledge_node',
      {
        syllabus_version_id: options.syllabusId,
        parent_id: options.parentId ?? null,
        kind: 'point',
        canonical_name: options.name,
        aliases: [],
        code: '',
        is_unclassified: false,
        display_order: 0,
      },
      { now: options.now },
    ).id,
  )
}
