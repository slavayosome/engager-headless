/**
 * Domain errors shared across the monorepo (Achromatic-style). Server actions /
 * MCP tools / API handlers map these to user-facing results or HTTP codes.
 */
export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly statusCode: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super("not_found", message, 404);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super("forbidden", message, 403);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super("unauthorized", message, 401);
  }
}

export class ValidationError extends AppError {
  constructor(message = "Invalid input") {
    super("validation", message, 400);
  }
}
