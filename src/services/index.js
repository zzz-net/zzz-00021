const incidentService = require('./incidentService');
const evidenceService = require('./evidenceService');
const auditService = require('./auditService');
const exportService = require('./exportService');
const importService = require('./importService');
const configService = require('./configService');
const receiptService = require('./receiptService');
const shiftHandoverService = require('./shiftHandoverService');

module.exports = {
  incidentService,
  evidenceService,
  auditService,
  exportService,
  importService,
  configService,
  receiptService,
  shiftHandoverService
};
