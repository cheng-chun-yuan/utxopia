// API Error handling utilities

export class ApiError extends Error {
  constructor(
    message: string,
    public code?: string,
    public statusCode?: number,
    public details?: string
  ) {
    super(message);
    this.name = "ApiError";
  }

  static fromResponse(error: { error?: string; code?: string; details?: string }, statusCode: number): ApiError {
    return new ApiError(
      error.error || `HTTP ${statusCode}`,
      error.code,
      statusCode,
      error.details
    );
  }

  static fromUnknown(error: unknown): ApiError {
    if (error instanceof ApiError) {
      return error;
    }
    if (error instanceof Error) {
      return new ApiError(error.message);
    }
    return new ApiError("Unknown error occurred");
  }
}
