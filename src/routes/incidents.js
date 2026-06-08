const express = require('express');
const router = express.Router();
const { incidentService, auditService } = require('../services');
const { createErrorResponse, ERROR_CODES } = require('../constants/errors');
const { INCIDENT_LEVEL } = require('../constants/status');
const { requirePermission } = require('../middleware/auth');

router.post('/', requirePermission('CREATE_INCIDENT'), (req, res) => {
  const { title, description, location, level, occurredAt } = req.body;

  const validationErrors = [];
  if (!title) validationErrors.push('title 是必填项');
  if (!location) validationErrors.push('location 是必填项');
  if (!level) validationErrors.push('level 是必填项');
  if (level && !Object.values(INCIDENT_LEVEL).includes(level)) {
    validationErrors.push('level 必须是: ' + Object.values(INCIDENT_LEVEL).join(', '));
  }

  if (validationErrors.length > 0) {
    return res.status(400).json(createErrorResponse(ERROR_CODES.VALIDATION_ERROR, validationErrors));
  }

  const incident = incidentService.createIncident(req.user, {
    title,
    description: description || '',
    location,
    level,
    occurredAt
  });

  res.status(201).json({
    success: true,
    data: incident
  });
});

router.get('/', (req, res) => {
  const { location, level, status } = req.query;
  const incidents = incidentService.getIncidentList({ location, level, status });

  res.json({
    success: true,
    data: incidents
  });
});

router.get('/:id', (req, res) => {
  const incident = incidentService.getIncidentDetail(req.params.id);
  if (!incident) {
    return res.status(404).json(createErrorResponse(ERROR_CODES.NOT_FOUND));
  }

  res.json({
    success: true,
    data: incident
  });
});

router.get('/:id/audit-logs', (req, res) => {
  const incident = incidentService.getIncidentDetail(req.params.id);
  if (!incident) {
    return res.status(404).json(createErrorResponse(ERROR_CODES.NOT_FOUND));
  }

  const logs = auditService.getIncidentAuditTrail(req.params.id);
  res.json({
    success: true,
    data: logs
  });
});

router.post('/:id/foreman-review', requirePermission('FOREMAN_REVIEW'), (req, res) => {
  const result = incidentService.foremanReview(req.user, req.params.id);
  if (!result.success) {
    const statusCode = result.error === ERROR_CODES.NOT_FOUND ? 404 : 400;
    return res.status(statusCode).json(createErrorResponse(result.error, result.details));
  }

  res.json({
    success: true,
    data: result.data
  });
});

router.post('/:id/security-confirm', requirePermission('SECURITY_CONFIRM'), (req, res) => {
  const result = incidentService.securityConfirm(req.user, req.params.id);
  if (!result.success) {
    const statusCode = result.error === ERROR_CODES.NOT_FOUND ? 404 : 400;
    return res.status(statusCode).json(createErrorResponse(result.error, result.details));
  }

  res.json({
    success: true,
    data: result.data
  });
});

router.post('/:id/close', requirePermission('CLOSE_INCIDENT'), (req, res) => {
  const result = incidentService.closeIncident(req.user, req.params.id);
  if (!result.success) {
    const statusCode = result.error === ERROR_CODES.NOT_FOUND ? 404 : 400;
    return res.status(statusCode).json(createErrorResponse(result.error, result.details));
  }

  res.json({
    success: true,
    data: result.data
  });
});

router.post('/:id/return', requirePermission('RETURN_INCIDENT'), (req, res) => {
  const { reason } = req.body;
  if (!reason) {
    return res.status(400).json(createErrorResponse(ERROR_CODES.VALIDATION_ERROR, ['退回原因 reason 是必填项']));
  }

  const result = incidentService.returnIncident(req.user, req.params.id, reason);
  if (!result.success) {
    const statusCode = result.error === ERROR_CODES.NOT_FOUND ? 404 : 400;
    return res.status(statusCode).json(createErrorResponse(result.error, result.details));
  }

  res.json({
    success: true,
    data: result.data
  });
});

router.post('/:id/start-evidence', requirePermission('ADD_EVIDENCE'), (req, res) => {
  const result = incidentService.startEvidenceCollection(req.user, req.params.id);
  if (!result.success) {
    const statusCode = result.error === ERROR_CODES.NOT_FOUND ? 404 : 400;
    return res.status(statusCode).json(createErrorResponse(result.error, result.details));
  }

  res.json({
    success: true,
    data: result.data
  });
});

module.exports = router;
