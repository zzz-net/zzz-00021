const express = require('express');
const router = express.Router();
const { exportService } = require('../services');
const { createErrorResponse, ERROR_CODES } = require('../constants/errors');
const { requirePermission } = require('../middleware/auth');

function sendExportResponse(res, result) {
  if (result.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.send('\uFEFF' + result.content);
  } else {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.send(result.content);
  }
}

router.get('/incidents', requirePermission('EXPORT_DATA'), (req, res) => {
  const format = req.query.format === 'csv' ? 'csv' : 'json';
  const result = exportService.exportIncidents(req.user, format);
  sendExportResponse(res, result);
});

router.get('/evidences', requirePermission('EXPORT_DATA'), (req, res) => {
  const format = req.query.format === 'csv' ? 'csv' : 'json';
  const { incidentId } = req.query;
  const result = exportService.exportEvidences(req.user, incidentId || null, format);
  sendExportResponse(res, result);
});

router.get('/audit-logs', requirePermission('EXPORT_DATA'), (req, res) => {
  const format = req.query.format === 'csv' ? 'csv' : 'json';
  const { incidentId, userId, action, startTime, endTime } = req.query;
  const filters = {};
  if (incidentId) filters.incidentId = incidentId;
  if (userId) filters.userId = userId;
  if (action) filters.action = action;
  if (startTime) filters.startTime = startTime;
  if (endTime) filters.endTime = endTime;
  
  const result = exportService.exportAuditLogs(req.user, filters, format);
  sendExportResponse(res, result);
});

module.exports = router;
