export type HandlerContext = {
  input: Record<string, unknown>;
  signal: AbortSignal;
  /** One-based attempt number, provided for deterministic test handlers. */
  attempt?: number;
};

export type BuiltInHandler = (
  config: Record<string, unknown>,
  context: HandlerContext,
) => Promise<Record<string, unknown>>;

export class HandlerError extends Error {
  constructor(
    message: string,
    public readonly code: 'VALIDATION_ERROR' | 'TIMEOUT' | 'HANDLER_ERROR' = 'HANDLER_ERROR',
  ) {
    super(message);
    this.name = 'HandlerError';
  }
}
