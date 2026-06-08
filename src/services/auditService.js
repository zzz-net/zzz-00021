const { auditLogsStore } = require('../storage');
const { AUDIT_ACTION } = require('../constants/status');

function logAction(userId, userName, action, incidentId = null, details = {}) {
  const logEntry = {
    id: `audit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    userId,
    userName,
    action,
    incidentId,
    details,
    timestamp: new Date().toISOString()
  };
  auditLogsStore.append(logEntry);
  return logEntry;
}

function getAuditLogs(filters = {}) {
  let logs = auditLogsStore.readAll();
  
  if (filters.incidentId) {
    logs = logs.filter(log => log.incidentId === filters.incidentId);
  }
  if (filters.userId) {
    logs = logs.filter(log => log.userId === filters.userId);
  }
  if (filters.action) {
    logs = logs.filter(log => log.action === filters.action);
  }
  if (filters.startTime) {
    logs = logs.filter(log => log.timestamp >= filters.startTime);
  }
  if (filters.endTime) {
    logs = logs.filter(log => log.timestamp <= filters.endTime);
  }
  
  return logs.sort((a, b) => a.sequence - b.sequence);
}

function getIncidentAuditTrail(incidentId) {
  return getAuditLogs({ incidentId });
}

module.exports = {
  logAction,
  getAuditLogs,
  getIncidentAuditTrail,
  AUDIT_ACTION
};
