const { v4: uuidv4 } = require('uuid');
const { incidentsStore, evidencesStore } = require('../storage');
const { INCIDENT_STATUS, INCIDENT_STATUS_FLOW } = require('../constants/status');
const { ERROR_CODES } = require('../constants/errors');
const { logAction, AUDIT_ACTION } = require('./auditService');

function createIncident(user, data) {
  const now = new Date().toISOString();
  const incident = {
    id: uuidv4(),
    title: data.title,
    description: data.description,
    location: data.location,
    level: data.level,
    occurredAt: data.occurredAt || now,
    status: INCIDENT_STATUS.REPORTED,
    reporterId: user.id,
    reporterName: user.name,
    currentHandlerId: user.id,
    currentHandlerName: user.name,
    returnReason: null,
    createdAt: now,
    updatedAt: now,
    evidenceCount: 0
  };

  incidentsStore.append(incident);
  logAction(user.id, user.name, AUDIT_ACTION.INCIDENT_CREATED, incident.id, {
    title: incident.title,
    location: incident.location,
    level: incident.level
  });

  return incident;
}

function getIncidentList(filters = {}) {
  let incidents = incidentsStore.readAll();

  if (filters.location) {
    incidents = incidents.filter(inc => 
      inc.location && inc.location.includes(filters.location)
    );
  }
  if (filters.level) {
    incidents = incidents.filter(inc => inc.level === filters.level);
  }
  if (filters.status) {
    incidents = incidents.filter(inc => inc.status === filters.status);
  }

  return incidents.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function getIncidentDetail(id) {
  const incident = incidentsStore.findById(id);
  if (!incident) return null;

  const evidences = evidencesStore.findMany(e => e.incidentId === id);
  const sortedEvidences = evidences.sort((a, b) => 
    new Date(a.collectedAt) - new Date(b.collectedAt)
  );

  return {
    ...incident,
    evidences: sortedEvidences
  };
}

function canTransitionStatus(currentStatus, targetStatus) {
  const allowed = INCIDENT_STATUS_FLOW[currentStatus];
  return allowed && allowed.includes(targetStatus);
}

function transitionStatus(user, incidentId, targetStatus, reason = null) {
  const incident = incidentsStore.findById(incidentId);
  if (!incident) {
    return { success: false, error: ERROR_CODES.NOT_FOUND };
  }

  if (!canTransitionStatus(incident.status, targetStatus)) {
    return { 
      success: false, 
      error: ERROR_CODES.INVALID_STATUS_TRANSITION,
      details: {
        currentStatus: incident.status,
        targetStatus,
        allowedTransitions: INCIDENT_STATUS_FLOW[incident.status]
      }
    };
  }

  const previousStatus = incident.status;
  const now = new Date().toISOString();

  const updated = incidentsStore.updateById(incidentId, (inc) => ({
    ...inc,
    status: targetStatus,
    currentHandlerId: user.id,
    currentHandlerName: user.name,
    returnReason: targetStatus === INCIDENT_STATUS.RETURNED ? reason : null,
    updatedAt: now
  }));

  logAction(user.id, user.name, AUDIT_ACTION.INCIDENT_STATUS_CHANGED, incidentId, {
    from: previousStatus,
    to: targetStatus,
    reason: reason || null
  });

  return { success: true, data: updated };
}

function foremanReview(user, incidentId) {
  return transitionStatus(user, incidentId, INCIDENT_STATUS.FOREMAN_REVIEWED);
}

function securityConfirm(user, incidentId) {
  return transitionStatus(user, incidentId, INCIDENT_STATUS.SECURITY_CONFIRMED);
}

function closeIncident(user, incidentId) {
  return transitionStatus(user, incidentId, INCIDENT_STATUS.CLOSED);
}

function returnIncident(user, incidentId, reason) {
  return transitionStatus(user, incidentId, INCIDENT_STATUS.RETURNED, reason);
}

function startEvidenceCollection(user, incidentId) {
  return transitionStatus(user, incidentId, INCIDENT_STATUS.EVIDENCE_COLLECTING);
}

function reopenIncident(user, incidentId, reason) {
  return transitionStatus(user, incidentId, INCIDENT_STATUS.EVIDENCE_COLLECTING, reason);
}

module.exports = {
  createIncident,
  getIncidentList,
  getIncidentDetail,
  foremanReview,
  securityConfirm,
  closeIncident,
  returnIncident,
  startEvidenceCollection,
  reopenIncident,
  canTransitionStatus
};
