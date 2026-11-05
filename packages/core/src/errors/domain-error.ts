export abstract class DomainError extends Error {
  public readonly code: string;
  public readonly httpStatus: number;

  protected constructor(message: string, code: string, httpStatus = 400, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export const isDomainError = (error: unknown): error is DomainError => error instanceof DomainError;
