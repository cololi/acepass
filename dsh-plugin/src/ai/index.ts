/**
 * Public surface of the AI layer.
 *
 * Everything exported here is pure: no clock, no storage, no network and no DSH import. The service
 * layer supplies model output, gets back a validated candidate plus the problems to audit, and uses
 * `outcome.ts` to decide what may be written.
 */
export * from './audit.ts'
export * from './content.ts'
export * from './degrade.ts'
export * from './outcome.ts'
export * from './prompts.ts'
export * from './pyvalue.ts'
export * from './validators.ts'
