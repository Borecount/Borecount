/** Runtime checks shared by constructors and guards for independently loaded errors. */
export const isErrorHttpStatus = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599;

export const isValidRetryAfterSeconds = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
