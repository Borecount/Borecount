const DOMAIN_ERROR_BRAND = Symbol.for('borecount.domain-error');

export abstract class DomainError extends Error {
  public readonly code: string;
  public readonly httpStatus: number;

  protected constructor(message: string, code: string, httpStatus = 400, options?: ErrorOptions) {
    if (!Number.isInteger(httpStatus) || httpStatus < 400 || httpStatus > 599) {
      throw new RangeError('httpStatus must be an integer between 400 and 599');
    }
    super(message, options);
    Object.defineProperty(this, DOMAIN_ERROR_BRAND, { value: true });
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

// Global symbols preserve classification across independently loaded copies of core.
export const isDomainError = (error: unknown): error is DomainError => {
  if (!(error instanceof Error)) return false;
  const candidate = error as DomainError & { [DOMAIN_ERROR_BRAND]?: unknown };
  return (
    candidate[DOMAIN_ERROR_BRAND] === true &&
    typeof candidate.code === 'string' &&
    Number.isInteger(candidate.httpStatus) &&
    candidate.httpStatus >= 400 &&
    candidate.httpStatus <= 599
  );
};
