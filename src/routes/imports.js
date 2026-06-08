const express = require('express');
const router = express.Router();
const { importService } = require('../services');
const { createErrorResponse, ERROR_CODES } = require('../constants/errors');
const { requirePermission } = require('../middleware/auth');

router.post('/archive', requirePermission('IMPORT_DATA'), (req, res) => {
  const mode = req.query.mode === 'commit' ? 'commit' : 'dryRun';
  const strategy = ['skip', 'newId'].includes(req.query.conflictStrategy)
    ? req.query.conflictStrategy
    : 'skip';
  const archive = req.body;

  const result = importService.importIncidentArchive(req.user, archive, {
    mode,
    conflictStrategy: strategy
  });

  if (!result.success) {
    if (result.error === ERROR_CODES.PERMISSION_DENIED) {
      return res.status(403).json(createErrorResponse(result.error, result.details));
    }
    return res.status(400).json(createErrorResponse(result.error, result.details));
  }

  res.json(result);
});

router.post('/batch', requirePermission('IMPORT_DATA'), (req, res) => {
  const body = req.body || {};
  const incidents = body.incidents;

  if (!Array.isArray(incidents) || incidents.length === 0) {
    return res.status(400).json(createErrorResponse(ERROR_CODES.VALIDATION_ERROR, {
      reason: '需要提供 incidents 数组'
    }));
  }

  const mode = req.query.mode === 'commit' ? 'commit' : 'dryRun';
  const strategy = ['skip', 'newId'].includes(req.query.conflictStrategy)
    ? req.query.conflictStrategy
    : 'skip';

  const result = importService.importIncidentsBatch(req.user, incidents, {
    mode,
    conflictStrategy: strategy
  });

  if (!result.success) {
    if (result.error === ERROR_CODES.PERMISSION_DENIED) {
      return res.status(403).json(createErrorResponse(result.error, result.details));
    }
    return res.status(400).json(createErrorResponse(result.error, result.details));
  }

  res.json(result);
});

module.exports = router;
