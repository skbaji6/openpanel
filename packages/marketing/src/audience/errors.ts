export class SourceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceUnavailableError';
  }
}

export class SourceAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceAuthError';
  }
}

export class SourceProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceProtocolError';
  }
}

// Our own queue pressure, not an upstream failure: deliberately not a SourceUnavailableError so the breaker ignores it.
export class SourceBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceBusyError';
  }
}
