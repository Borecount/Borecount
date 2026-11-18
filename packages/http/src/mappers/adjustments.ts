import type { AdjustmentResult } from '@borecount/core/application';
import type { AdjustmentResponse } from '../contracts/adjustments';

export const toAdjustmentResponse = (result: AdjustmentResult): AdjustmentResponse => ({
  transaction_id: result.transactionId,
  created: result.created,
});
