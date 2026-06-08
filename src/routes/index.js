const express = require('express');
const router = express.Router();

const incidentsRouter = require('./incidents');
const evidencesRouter = require('./evidences');
const exportsRouter = require('./exports');
const usersRouter = require('./users');
const { authMiddleware } = require('../middleware/auth');

router.use('/users', authMiddleware, usersRouter);
router.use('/incidents', authMiddleware, incidentsRouter);
router.use('/incidents/:incidentId/evidences', authMiddleware, evidencesRouter);
router.use('/export', authMiddleware, exportsRouter);

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
  const { INCIDENT_STATUS, INCIDENT_LEVEL, USER_ROLE } = require('../constants/status');
  res.json({
    success: true,
    data: {
      incidentStatus: INCIDENT_STATUS,
      incidentLevel: INCIDENT_LEVEL,
      userRole: USER_ROLE
    }
  });
});

module.exports = router;
