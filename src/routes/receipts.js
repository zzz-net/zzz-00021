const express = require('express');
const router = express.Router();
const { receiptService } = require('../services');
const { createErrorResponse, ERROR_CODES } = require('../constants/errors');
const { logAction, AUDIT_ACTION } = require('../services/auditService');

function requireReceiptPermission(req, res, next) {
  if (!req.user) {
    return res.status(401).json(createErrorResponse(ERROR_CODES.UNAUTHORIZED));
  }
  const allowedRoles = ['admin', 'security'];
  if (!allowedRoles.includes(req.user.role)) {
    logAction(req.user.id, req.user.name, AUDIT_ACTION.RECEIPT_CREATE_FAILED, null, {
      type: 'permission_denied',
      reason: 'role not allowed',
      userRole: req.user.role,
      path: req.path,
      method: req.method
    });
    return res.status(403).json(createErrorResponse(ERROR_CODES.PERMISSION_DENIED, {
      required: 'CREATE_RECEIPT or REVOKE_RECEIPT or VIEW_RECEIPT',
      userRole: req.user.role,
      allowedRoles
    }));
  }
  next();
}

router.post('/packages', requireReceiptPermission, (req, res) => {
  const body = req.body || {};
  const incidentId = body.incidentId;

  if (!incidentId || typeof incidentId !== 'string' || incidentId.trim().length === 0) {
    logAction(req.user.id, req.user.name, AUDIT_ACTION.RECEIPT_CREATE_FAILED, null, {
      reason: 'missing_incidentId'
    });
    return res.status(400).json(createErrorResponse(ERROR_CODES.VALIDATION_ERROR, {
      reason: '缺少 incidentId 字段'
    }));
  }

  const options = {};
  if (body.conflictStrategy === 'supersede' || body.conflictStrategy === 'error') {
    options.conflictStrategy = body.conflictStrategy;
  }
  if (typeof body.deadlineHours === 'number' && body.deadlineHours > 0) {
    options.deadlineHours = body.deadlineHours;
  }
  if (typeof body.receiverName === 'string' && body.receiverName.trim().length > 0) {
    options.receiverName = body.receiverName.trim();
  }

  const result = receiptService.createReceiptPackage(req.user, incidentId.trim(), options);

  if (!result.success) {
    const statusMap = {
      [ERROR_CODES.NOT_FOUND]: 404,
      [ERROR_CODES.RECEIPT_INCIDENT_NOT_CLOSED]: 400,
      [ERROR_CODES.RECEIPT_NO_EVIDENCE]: 400,
      [ERROR_CODES.RECEIPT_CONFLICT]: 409,
      [ERROR_CODES.RECEIPT_CREATE_FAILED]: 500,
      [ERROR_CODES.PERMISSION_DENIED]: 403
    };
    return res.status(statusMap[result.error] || 400).json(
      createErrorResponse(result.error, result.details)
    );
  }

  res.status(201).json({
    success: true,
    data: result.data
  });
});

router.get('/packages', requireReceiptPermission, (req, res) => {
  const filters = {};
  if (req.query.incidentId) filters.incidentId = req.query.incidentId;
  if (req.query.status) filters.status = req.query.status;
  if (req.query.creatorId) filters.creatorId = req.query.creatorId;

  const result = receiptService.listReceiptPackages(req.user, filters);
  res.json({
    success: true,
    data: result.data
  });
});

router.get('/packages/:packageId', requireReceiptPermission, (req, res) => {
  const result = receiptService.getReceiptPackage(req.user, req.params.packageId);

  if (!result.success) {
    return res.status(404).json(
      createErrorResponse(result.error, result.details)
    );
  }

  res.json({
    success: true,
    data: result.data
  });
});

router.post('/packages/:packageId/revoke', requireReceiptPermission, (req, res) => {
  const body = req.body || {};
  const reason = typeof body.reason === 'string' ? body.reason.trim() : null;

  const result = receiptService.revokeReceiptPackage(req.user, req.params.packageId, reason);

  if (!result.success) {
    const statusMap = {
      [ERROR_CODES.RECEIPT_NOT_FOUND]: 404,
      [ERROR_CODES.RECEIPT_REVOKED]: 409,
      [ERROR_CODES.RECEIPT_ALREADY_SIGNED]: 409,
      [ERROR_CODES.RECEIPT_REVOKE_FAILED]: 500
    };
    return res.status(statusMap[result.error] || 400).json(
      createErrorResponse(result.error, result.details)
    );
  }

  res.json({
    success: true,
    data: result.data
  });
});

module.exports = router;
