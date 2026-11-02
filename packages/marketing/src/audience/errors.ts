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
