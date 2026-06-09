const isProd = process.env.NODE_ENV === 'production';

// ─── ERROR CLASSES ────────────────────────────────────────

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
    this.code = 'VALIDATION_ERROR';
    this.isOperational = true; // user mistake → safe to show
  }
}

class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
    this.statusCode = 401;
    this.code = 'AUTH_ERROR';
    this.isOperational = true; // user mistake → safe to show
  }
}

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.statusCode = 404;
    this.code = 'NOT_FOUND';
    this.isOperational = true; // user mistake → safe to show
  }
}

class ServiceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ServiceError';
    this.statusCode = 500;
    this.code = 'SERVICE_ERROR';
    this.isOperational = false; // our bug → hide in production
  }
}

// ─── ERROR HANDLER MIDDLEWARE ─────────────────────────────

function errorHandler(err, req, res, next) {

  // Fix 2 — better logging
  console.error({
    type: err.name,
    message: err.message,
    code: err.code || 'UNKNOWN_ERROR',
    stack: err.stack,
    path: req.path,
    method: req.method
  });

  const statusCode = err.statusCode || 500;

  // Fix 3 — hide internal errors in production
  const message = err.isOperational
    ? err.message
    : isProd
      ? 'Internal Server Error'
      : err.message;

  // Fix 4 — consistent error shape with codes
  res.status(statusCode).json({
    success: false,
    timestamp: new Date().toISOString(),
    requestId: res.locals.requestId || null,
    error: {
      type: err.name || 'Error',
      message,
      code: err.code || 'UNKNOWN_ERROR'
    }
  });
}

module.exports = {
  ValidationError,
  AuthError,
  NotFoundError,
  ServiceError,
  errorHandler
};