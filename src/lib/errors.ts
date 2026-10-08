export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
export class ProviderError extends Error {
  constructor(public code: string, public ambiguous = false) { super(code); }
}
