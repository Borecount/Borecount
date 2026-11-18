import { whereQueryProperty } from '../query/list-filter';
import {
  holdCaptureFilterFields,
  holdCreditAllocationFilterFields,
  holdEntryFilterFields,
  holdSummaryFilterFields,
} from '../query/list-filter-fields';
import type { InferSchema } from '../schema-types';
import { NonEmptyTrimmedStringSchema } from './common';
import { createPaginatedResponseSchema, mergePaginationQuerySchema } from './pagination';
import { transactionByIdParamsSchema, transactionEntryRequestSchema } from './transactions';

const uuid = { type: 'string', format: 'uuid' } as const;
const positiveMinor = { type: 'string', pattern: '^[1-9][0-9]*$' } as const;
const signedMinor = { type: 'string', pattern: '^-?[1-9][0-9]*$' } as const;
const amount = { type: 'string', pattern: '^[0-9]+$' } as const;

export const holdSummaryResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'ledger_id',
    'reference',
    'currency',
    'description',
    'state',
    'original_amount_minor',
    'remaining_amount_minor',
    'created_at',
    'applied_at',
    'voided_at',
  ],
  properties: {
    id: uuid,
    ledger_id: uuid,
    reference: { type: 'string' },
    currency: { type: 'string' },
    description: { type: 'string', nullable: true },
    state: { type: 'string', enum: ['HELD', 'APPLIED', 'VOIDED'] },
    original_amount_minor: {
      ...positiveMinor,
      description: 'Original immutable amount reserved by the hold.',
    },
    remaining_amount_minor: amount,
    created_at: { type: 'string', format: 'date-time' },
    applied_at: { type: 'string', format: 'date-time', nullable: true },
    voided_at: { type: 'string', format: 'date-time', nullable: true },
  },
} as const;

export const holdEntryResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'account_id', 'signed_amount_minor', 'currency', 'created_at'],
  properties: {
    id: uuid,
    account_id: uuid,
    signed_amount_minor: signedMinor,
    currency: { type: 'string' },
    created_at: { type: 'string', format: 'date-time' },
  },
} as const;

export const holdCaptureResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'reference', 'amount_minor', 'currency', 'created_at'],
  properties: {
    id: { ...uuid, description: 'Posted capture transaction UUID.' },
    reference: { type: 'string' },
    amount_minor: positiveMinor,
    currency: { type: 'string' },
    created_at: { type: 'string', format: 'date-time' },
  },
} as const;

export const holdCreditAllocationResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'hold_entry_id', 'account_id', 'grant_id', 'amount_minor', 'created_at'],
  properties: {
    id: uuid,
    hold_entry_id: uuid,
    account_id: uuid,
    grant_id: uuid,
    amount_minor: {
      ...positiveMinor,
      description:
        'Original immutable allocation amount; it does not change with current capacity.',
    },
    created_at: { type: 'string', format: 'date-time' },
  },
} as const;

export const holdsPageResponseSchema = createPaginatedResponseSchema(holdSummaryResponseSchema);
export const holdEntriesPageResponseSchema = createPaginatedResponseSchema(holdEntryResponseSchema);
export const holdCapturesPageResponseSchema =
  createPaginatedResponseSchema(holdCaptureResponseSchema);
export const holdCreditAllocationsPageResponseSchema = createPaginatedResponseSchema(
  holdCreditAllocationResponseSchema,
);

export const listHoldsQuerySchema = mergePaginationQuerySchema({
  properties: { where: whereQueryProperty(holdSummaryFilterFields) },
});
export const listHoldEntriesQuerySchema = mergePaginationQuerySchema({
  properties: { where: whereQueryProperty(holdEntryFilterFields) },
});
export const listHoldCapturesQuerySchema = mergePaginationQuerySchema({
  properties: { where: whereQueryProperty(holdCaptureFilterFields) },
});
export const listHoldCreditAllocationsQuerySchema = mergePaginationQuerySchema({
  properties: { where: whereQueryProperty(holdCreditAllocationFilterFields) },
});

export const holdIdParamsSchema = transactionByIdParamsSchema;

export const holdEntryRequestSchema = transactionEntryRequestSchema;

export const createHoldRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['ledger_id', 'reference', 'currency', 'entries'],
  properties: {
    ledger_id: { type: 'string', format: 'uuid' },
    reference: NonEmptyTrimmedStringSchema,
    currency: NonEmptyTrimmedStringSchema,
    description: NonEmptyTrimmedStringSchema,
    entries: { type: 'array', minItems: 2, items: holdEntryRequestSchema },
  },
} as const;

export const commitHoldRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['reference'],
  properties: {
    reference: NonEmptyTrimmedStringSchema,
    amount_minor: { type: 'string', pattern: '^[1-9][0-9]*$' },
  },
} as const;

export const createHoldResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['hold_id', 'created', 'state', 'remaining_amount_minor'],
  properties: {
    hold_id: { type: 'string', format: 'uuid' },
    created: { type: 'boolean' },
    state: { type: 'string', enum: ['HELD', 'APPLIED', 'VOIDED'] },
    remaining_amount_minor: { type: 'string', pattern: '^[0-9]+$' },
  },
} as const;

export const commitHoldResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['hold_id', 'transaction_id', 'created', 'state', 'remaining_amount_minor'],
  properties: {
    hold_id: { type: 'string', format: 'uuid' },
    transaction_id: { type: 'string', format: 'uuid' },
    created: { type: 'boolean' },
    state: { type: 'string', enum: ['HELD', 'APPLIED', 'VOIDED'] },
    remaining_amount_minor: { type: 'string', pattern: '^[0-9]+$' },
  },
} as const;

export const voidHoldResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['hold_id', 'state', 'voided', 'remaining_amount_minor'],
  properties: {
    hold_id: { type: 'string', format: 'uuid' },
    state: { type: 'string', enum: ['VOIDED'] },
    voided: { type: 'boolean' },
    remaining_amount_minor: { type: 'string', pattern: '^[0-9]+$' },
  },
} as const;

export type HoldEntryRequest = InferSchema<typeof holdEntryRequestSchema>;
export type HoldSummaryResponse = InferSchema<typeof holdSummaryResponseSchema>;
export type HoldEntryResponse = InferSchema<typeof holdEntryResponseSchema>;
export type HoldCaptureResponse = InferSchema<typeof holdCaptureResponseSchema>;
export type HoldCreditAllocationResponse = InferSchema<typeof holdCreditAllocationResponseSchema>;
export type HoldsPageResponse = InferSchema<typeof holdsPageResponseSchema>;
export type HoldEntriesPageResponse = InferSchema<typeof holdEntriesPageResponseSchema>;
export type HoldCapturesPageResponse = InferSchema<typeof holdCapturesPageResponseSchema>;
export type HoldCreditAllocationsPageResponse = InferSchema<
  typeof holdCreditAllocationsPageResponseSchema
>;
export type ListHoldsQuery = InferSchema<typeof listHoldsQuerySchema>;
export type ListHoldEntriesQuery = InferSchema<typeof listHoldEntriesQuerySchema>;
export type ListHoldCapturesQuery = InferSchema<typeof listHoldCapturesQuerySchema>;
export type ListHoldCreditAllocationsQuery = InferSchema<
  typeof listHoldCreditAllocationsQuerySchema
>;
export type HoldIdParams = InferSchema<typeof holdIdParamsSchema>;
export type CreateHoldRequest = InferSchema<typeof createHoldRequestSchema>;
export type CreateHoldResponse = InferSchema<typeof createHoldResponseSchema>;
export type CommitHoldRequest = InferSchema<typeof commitHoldRequestSchema>;
export type CommitHoldResponse = InferSchema<typeof commitHoldResponseSchema>;
export type VoidHoldResponse = InferSchema<typeof voidHoldResponseSchema>;
