const ERROR_CODES = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  NOT_FOUND: 'NOT_FOUND',
  INVALID_STATUS_TRANSITION: 'INVALID_STATUS_TRANSITION',
  EVIDENCE_TIME_TOO_EARLY: 'EVIDENCE_TIME_TOO_EARLY',
  DUPLICATE_EVIDENCE_HASH: 'DUPLICATE_EVIDENCE_HASH',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED'
};

const ERROR_MESSAGES = {
  [ERROR_CODES.VALIDATION_ERROR]: '请求参数验证失败',
  [ERROR_CODES.PERMISSION_DENIED]: '权限不足，无法执行该操作',
  [ERROR_CODES.NOT_FOUND]: '资源不存在',
  [ERROR_CODES.INVALID_STATUS_TRANSITION]: '无效的状态流转',
  [ERROR_CODES.EVIDENCE_TIME_TOO_EARLY]: '证据采集时间早于事故发生时间',
  [ERROR_CODES.DUPLICATE_EVIDENCE_HASH]: '同一事故下已存在相同哈希的证据',
  [ERROR_CODES.INTERNAL_ERROR]: '服务器内部错误',
  [ERROR_CODES.UNAUTHORIZED]: '未授权访问，请提供有效的用户信息'
};

function createErrorResponse(code, details = null) {
  const response = {
    success: false,
    error: {
      code,
      message: ERROR_MESSAGES[code] || '未知错误'
    }
  };
  if (details) {
    response.error.details = details;
  }
  return response;
}

module.exports = {
  ERROR_CODES,
  ERROR_MESSAGES,
  createErrorResponse
};
