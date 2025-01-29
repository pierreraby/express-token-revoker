export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class InternalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InternalError';
  }
}