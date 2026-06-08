const express = require('express');
const router = express.Router();
const { exportService, configService } = require('../services');
const { createErrorResponse, ERROR_CODES } = require('../constants/errors');
const { logAction, AUDIT_ACTION } = require('../services/auditService');

function requireExportPermission(req, res, next) {
  if (!req.user) {
    return res.status(401).json(createErrorResponse(ERROR_CODES.UNAUTHORIZED));
  }
  const allowedRoles = ['admin', 'security'];
  if (!allowedRoles.includes(req.user.role)) {
    logAction(req.user.id, req.user.name, AUDIT_ACTION.DATA_EXPORT_FAILED, null, {
      type: 'permission_denied',
      reason: 'role not allowed',
      userRole: req.user.role,
      path: req.path,
      method: req.method
    });
    return res.status(403).json(createErrorResponse(ERROR_CODES.PERMISSION_DENIED, {
      required: 'EXPORT_DATA',
      userRole: req.user.role,
      allowedRoles
    }));
  }
  next();
}

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

router.get('/incidents', requireExportPermission, (req, res) => {
  const format = req.query.format === 'csv' ? 'csv' : 'json';
  const result = exportService.exportIncidents(req.user, format);
  sendExportResponse(res, result);
});

router.get('/evidences', requireExportPermission, (req, res) => {
  const format = req.query.format === 'csv' ? 'csv' : 'json';
  const { incidentId } = req.query;
  const result = exportService.exportEvidences(req.user, incidentId || null, format);
  sendExportResponse(res, result);
});

router.get('/audit-logs', requireExportPermission, (req, res) => {
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

router.get('/incident-archive/:incidentId', requireExportPermission, (req, res) => {
  const format = req.query.format === 'csv' ? 'csv' : 'json';
  const download = req.query.download === 'true' || req.query.download === '1';

  const result = exportService.exportIncidentArchive(
    req.user,
    req.params.incidentId,
    format,
    { downloadOnly: download }
  );

  if (!result.success) {
    const statusMap = {
      [ERROR_CODES.NOT_FOUND]: 404,
      [ERROR_CODES.EXPORT_CONFLICT]: 409,
      [ERROR_CODES.EXPORT_FAILED]: 500
    };
    return res.status(statusMap[result.error] || 500).json(
      createErrorResponse(result.error, result.details)
    );
  }

  if (download) {
    const archiveName = `${result.data.archiveName}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${archiveName}"`);
    return res.json({
      manifest: result.data.manifest,
      files: result.data.files
    });
  }

  res.json({
    success: true,
    data: result.data
  });
});

router.post('/incident-archive/:incidentId', requireExportPermission, (req, res) => {
  const format = (req.body && req.body.format === 'csv') ? 'csv' : 'json';
  const download = (req.body && (req.body.download === true || req.body.download === 'true' || req.body.download === '1'));

  const result = exportService.exportIncidentArchive(
    req.user,
    req.params.incidentId,
    format,
    { downloadOnly: download }
  );

  if (!result.success) {
    const statusMap = {
      [ERROR_CODES.NOT_FOUND]: 404,
      [ERROR_CODES.EXPORT_CONFLICT]: 409,
      [ERROR_CODES.EXPORT_FAILED]: 500
    };
    return res.status(statusMap[result.error] || 500).json(
      createErrorResponse(result.error, result.details)
    );
  }

  if (download) {
    const archiveName = `${result.data.archiveName}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${archiveName}"`);
    return res.json({
      manifest: result.data.manifest,
      files: result.data.files
    });
  }

  res.json({
    success: true,
    data: result.data
  });
});

router.get('/config', requireExportPermission, (req, res) => {
  const config = configService.getExportConfig();
  res.json({
    success: true,
    data: config
  });
});

router.put('/config', requireExportPermission, (req, res) => {
  try {
    const updated = configService.updateExportConfig(req.user, req.body || {});
    res.json({
      success: true,
      data: updated
    });
  } catch (err) {
    res.status(400).json(createErrorResponse(ERROR_CODES.VALIDATION_ERROR, {
      message: err.message
    }));
  }
});

router.get('/saved', requireExportPermission, (req, res) => {
  const list = exportService.listSavedExports();
  res.json({
    success: true,
    data: list
  });
});

module.exports = router;
