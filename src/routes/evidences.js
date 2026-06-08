const express = require('express');
const router = express.Router({ mergeParams: true });
const { evidenceService, incidentService } = require('../services');
const { createErrorResponse, ERROR_CODES } = require('../constants/errors');
const { requirePermission } = require('../middleware/auth');

router.post('/', requirePermission('ADD_EVIDENCE'), (req, res) => {
  const { incidentId } = req.params;
  const { type, description, collectedAt, filePath, fileHash } = req.body;

  const validationErrors = [];
  if (!filePath && !fileHash) {
    validationErrors.push('filePath 或 fileHash 至少提供一项');
  }

  if (validationErrors.length > 0) {
    return res.status(400).json(createErrorResponse(ERROR_CODES.VALIDATION_ERROR, validationErrors));
  }

  const result = evidenceService.addEvidence(req.user, incidentId, {
    type,
    description: description || '',
    collectedAt,
    filePath,
    fileHash
  });

  if (!result.success) {
    let statusCode = 400;
    if (result.error === ERROR_CODES.NOT_FOUND) statusCode = 404;
    if (result.error === ERROR_CODES.EVIDENCE_TIME_TOO_EARLY) statusCode = 400;
    if (result.error === ERROR_CODES.DUPLICATE_EVIDENCE_HASH) statusCode = 409;
    if (result.error === ERROR_CODES.INCIDENT_CLOSED) statusCode = 400;
    return res.status(statusCode).json(createErrorResponse(result.error, result.details));
  }

  res.status(201).json({
    success: true,
    data: result.data
  });
});

router.get('/', (req, res) => {
  const { incidentId } = req.params;
  const incident = incidentService.getIncidentDetail(incidentId);
  if (!incident) {
    return res.status(404).json(createErrorResponse(ERROR_CODES.NOT_FOUND));
  }

  const evidences = evidenceService.getEvidencesByIncident(incidentId);
  res.json({
    success: true,
    data: evidences
  });
});

router.get('/:evidenceId', (req, res) => {
  const { incidentId, evidenceId } = req.params;
  const evidence = evidenceService.getEvidenceById(evidenceId);
  
  if (!evidence || evidence.incidentId !== incidentId) {
    return res.status(404).json(createErrorResponse(ERROR_CODES.NOT_FOUND));
  }

  res.json({
    success: true,
    data: evidence
  });
});

module.exports = router;
