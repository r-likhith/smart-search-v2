// Standard success response
function successResponse(res, data, statusCode = 200) {
  return res.status(statusCode).json({
    success: true,
    timestamp: new Date().toISOString(),
    requestId: res.locals.requestId || null,
    data
  });
}

// Standard error response
function errorResponse(res, message, statusCode = 500, code = 'UNKNOWN_ERROR') {
  return res.status(statusCode).json({
    success: false,
    timestamp: new Date().toISOString(),
    requestId: res.locals.requestId || null,
    error: {
      type: 'Error',
      message,
      code
    }
  });
}

module.exports = { successResponse, errorResponse };