/** Error with a stable code and the HTTP status the API should answer. */
export class HumanError extends Error {
  constructor(code, message, http = 400, extra = {}) {
    super(message);
    this.name = 'HumanError';
    this.code = code;
    this.http = http;
    Object.assign(this, extra);
  }
}

/** Raised by a port when the backend/MCP answers with an error (never carries a secret). */
export class PortError extends Error {
  constructor(code, message, { retryable = false, retryAfterSeconds, httpStatus, source } = {}) {
    super(message);
    this.name = 'PortError';
    this.code = code;
    this.retryable = retryable;
    this.retryAfterSeconds = retryAfterSeconds;
    this.httpStatus = httpStatus;
    this.source = source;
  }
}

export class ContractDriftError extends Error {
  constructor(problems) {
    super(`AIWORKPAY MCP contract drift: ${problems.join('; ')}`);
    this.name = 'ContractDriftError';
    this.code = 'CONTRACT_DRIFT';
    this.problems = problems;
  }
}
