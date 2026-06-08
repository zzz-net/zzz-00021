const express = require('express');
const router = express.Router();

const incidentsRouter = require('./incidents');
const evidencesRouter = require('./evidences');
const exportsRouter = require('./exports');
const importsRouter = require('./imports');
const receiptsRouter = require('./receipts');
const receiptsPublicRouter = require('./receipts-public');
const usersRouter = require('./users');
const { authMiddleware } = require('../middleware/auth');

router.use('/users', authMiddleware, usersRouter);
router.use('/incidents', authMiddleware, incidentsRouter);
router.use('/incidents/:incidentId/evidences', authMiddleware, evidencesRouter);
router.use('/export', authMiddleware, exportsRouter);
router.use('/import', authMiddleware, importsRouter);
router.use('/receipts', receiptsPublicRouter);
router.use('/receipts', authMiddleware, receiptsRouter);

router.get('/health', (req, res) => {
  res.json({
    success: true,
    data: {
      status: 'ok',
      timestamp: new Date().toISOString()
    }
  });
});

router.get('/constants', (req, res) => {
  const { INCIDENT_STATUS, INCIDENT_LEVEL, USER_ROLE, RECEIPT_PACKAGE_STATUS, RECEIPT_CONFLICT_STRATEGY, SORT_FIELDS, SORT_DIRECTIONS } = require('../constants/status');
  res.json({
    success: true,
    data: {
      incidentStatus: INCIDENT_STATUS,
      incidentLevel: INCIDENT_LEVEL,
      userRole: USER_ROLE,
      receiptPackageStatus: RECEIPT_PACKAGE_STATUS,
      receiptConflictStrategy: RECEIPT_CONFLICT_STRATEGY,
      sortFields: SORT_FIELDS,
      sortDirections: SORT_DIRECTIONS
    }
  });
});

module.exports = router;
