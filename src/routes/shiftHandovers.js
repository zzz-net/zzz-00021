const express = require('express');
const router = express.Router();
const { shiftHandoverService } = require('../services');
const { createErrorResponse, ERROR_CODES } = require('../constants/errors');
const { requirePermission } = require('../middleware/auth');
const { logAction, AUDIT_ACTION } = require('../services/auditService');
const { PERMISSIONS } = require('../constants/status');

function requireShiftHandoverPermission(permissionKey, failedAction) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json(createErrorResponse(ERROR_CODES.UNAUTHORIZED));
    }
    const allowedRoles = PERMISSIONS[permissionKey];
    if (!allowedRoles || !allowedRoles.includes(req.user.role)) {
      if (failedAction) {
        logAction(req.user.id, req.user.name, failedAction, null, {
          type: 'permission_denied',
          reason: 'role not allowed',
          userRole: req.user.role,
          requiredPermission: permissionKey,
          path: req.path,
          method: req.method
        });
      }
      return res.status(403).json(createErrorResponse(ERROR_CODES.PERMISSION_DENIED, {
        required: permissionKey,
        userRole: req.user.role,
        allowedRoles
      }));
    }
    next();
  };
}

router.post('/', requireShiftHandoverPermission('CREATE_SHIFT_HANDOVER', AUDIT_ACTION.SHIFT_HANDOVER_CREATE_FAILED), (req, res) => {
  const { takeoverUserId, shiftStart, shiftEnd, incidentIds, remark } = req.body;

  const validationErrors = [];
  if (!takeoverUserId) validationErrors.push('takeoverUserId 是必填项');
  if (!shiftStart) validationErrors.push('shiftStart 是必填项');
  if (!shiftEnd) validationErrors.push('shiftEnd 是必填项');
  if (shiftStart && isNaN(new Date(shiftStart).getTime())) {
    validationErrors.push('shiftStart 必须是有效的 ISO 8601 日期字符串');
  }
  if (shiftEnd && isNaN(new Date(shiftEnd).getTime())) {
    validationErrors.push('shiftEnd 必须是有效的 ISO 8601 日期字符串');
  }
  if (incidentIds && !Array.isArray(incidentIds)) {
    validationErrors.push('incidentIds 必须是数组');
  }

  if (validationErrors.length > 0) {
    logAction(req.user.id, req.user.name, AUDIT_ACTION.SHIFT_HANDOVER_CREATE_FAILED, null, {
      reason: 'validation_error',
      errors: validationErrors
    });
    return res.status(400).json(createErrorResponse(ERROR_CODES.VALIDATION_ERROR, validationErrors));
  }

  const result = shiftHandoverService.createShiftHandover(req.user, {
    takeoverUserId,
    shiftStart,
    shiftEnd,
    incidentIds,
    remark
  });

  if (!result.success) {
    let statusCode = 400;
    if (result.error === ERROR_CODES.SHIFT_HANDOVER_INVALID_INCIDENT) {
      statusCode = 400;
    }
    return res.status(statusCode).json(createErrorResponse(result.error, result.details));
  }

  res.status(201).json({
    success: true,
    data: result.data
  });
});

router.get('/', requirePermission('VIEW_SHIFT_HANDOVER'), (req, res) => {
  const { status, handoverUserId, takeoverUserId } = req.query;
  const list = shiftHandoverService.getShiftHandoverList(req.user, {
    status,
    handoverUserId,
    takeoverUserId
  });

  res.json({
    success: true,
    data: list
  });
});

router.get('/:id', requirePermission('VIEW_SHIFT_HANDOVER'), (req, res) => {
  const result = shiftHandoverService.getShiftHandoverDetail(req.user, req.params.id);
  if (!result.success) {
    return res.status(404).json(createErrorResponse(result.error));
  }

  res.json({
    success: true,
    data: result.data
  });
});

router.post('/:id/confirm', requireShiftHandoverPermission('CONFIRM_SHIFT_HANDOVER', AUDIT_ACTION.SHIFT_HANDOVER_CONFIRM_FAILED), (req, res) => {
  const result = shiftHandoverService.confirmShiftHandover(req.user, req.params.id);
  if (!result.success) {
    let statusCode = 400;
    if (result.error === ERROR_CODES.SHIFT_HANDOVER_NOT_FOUND) {
      statusCode = 404;
    } else if (
      result.error === ERROR_CODES.SHIFT_HANDOVER_ALREADY_CONFIRMED ||
      result.error === ERROR_CODES.SHIFT_HANDOVER_ALREADY_REVOKED ||
      result.error === ERROR_CODES.SHIFT_HANDOVER_CONFLICT
    ) {
      statusCode = 409;
    }
    return res.status(statusCode).json(createErrorResponse(result.error, result.details));
  }

  res.json({
    success: true,
    data: result.data
  });
});

router.post('/:id/revoke', requireShiftHandoverPermission('REVOKE_SHIFT_HANDOVER', AUDIT_ACTION.SHIFT_HANDOVER_REVOKE_FAILED), (req, res) => {
  const { reason } = req.body || {};
  const result = shiftHandoverService.revokeShiftHandover(req.user, req.params.id, reason);
  if (!result.success) {
    let statusCode = 400;
    if (result.error === ERROR_CODES.SHIFT_HANDOVER_NOT_FOUND) {
      statusCode = 404;
    } else if (
      result.error === ERROR_CODES.SHIFT_HANDOVER_ALREADY_CONFIRMED ||
      result.error === ERROR_CODES.SHIFT_HANDOVER_ALREADY_REVOKED ||
      result.error === ERROR_CODES.SHIFT_HANDOVER_NOT_CREATOR
    ) {
      statusCode = 409;
    }
    return res.status(statusCode).json(createErrorResponse(result.error, result.details));
  }

  res.json({
    success: true,
    data: result.data
  });
});

module.exports = router;
