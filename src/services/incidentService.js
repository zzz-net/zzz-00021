const { v4: uuidv4 } = require('uuid');
const { incidentsStore, evidencesStore } = require('../storage');
const { 
  INCIDENT_STATUS, 
  INCIDENT_STATUS_FLOW, 
  INCIDENT_LEVEL, 
  USER_ROLE, 
  PERMISSIONS,
  SORT_FIELDS,
  SORT_DIRECTIONS,
  LEVEL_ORDER
} = require('../constants/status');
const { ERROR_CODES } = require('../constants/errors');
const { logAction, AUDIT_ACTION } = require('./auditService');
const { getOverdueConfig } = require('./configService');

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

function isIncidentOverdue(incident) {
  if (incident.status === INCIDENT_STATUS.CLOSED) {
    return false;
  }
  const overdueConfig = getOverdueConfig();
  const limitHours = overdueConfig[incident.level] || 0;
  if (limitHours <= 0) return false;
  const createdAt = new Date(incident.createdAt).getTime();
  const now = Date.now();
  const diffHours = (now - createdAt) / (1000 * 60 * 60);
  return diffHours > limitHours;
}

function parseSortParam(sort) {
  if (!sort) return null;
  const [field, direction] = sort.split(':');
  const validFields = Object.values(SORT_FIELDS);
  const validDirections = Object.values(SORT_DIRECTIONS);
  
  if (!validFields.includes(field)) {
    const error = new Error(`sort 字段无效: ${field}。有效值: ${validFields.join(', ')}`);
    error.code = ERROR_CODES.VALIDATION_ERROR;
    error.field = 'sort';
    throw error;
  }
  
  const dir = direction || SORT_DIRECTIONS.DESC;
  if (!validDirections.includes(dir)) {
    const error = new Error(`sort 方向无效: ${dir}。有效值: ${validDirections.join(', ')}`);
    error.code = ERROR_CODES.VALIDATION_ERROR;
    error.field = 'sort';
    throw error;
  }
  
  return { field, direction: dir };
}

function validateFilters(filters) {
  const errors = [];
  
  if (filters.createdFrom && isNaN(new Date(filters.createdFrom).getTime())) {
    errors.push('createdFrom 必须是有效的 ISO 8601 日期字符串');
  }
  if (filters.createdTo && isNaN(new Date(filters.createdTo).getTime())) {
    errors.push('createdTo 必须是有效的 ISO 8601 日期字符串');
  }
  if (filters.level && !Object.values(INCIDENT_LEVEL).includes(filters.level)) {
    errors.push(`level 无效: ${filters.level}。有效值: ${Object.values(INCIDENT_LEVEL).join(', ')}`);
  }
  
  if (errors.length > 0) {
    const error = new Error(errors.join('; '));
    error.code = ERROR_CODES.VALIDATION_ERROR;
    error.details = errors;
    throw error;
  }
}

function applyPermissionFilter(user, incidents) {
  const canViewAll = PERMISSIONS.VIEW_ALL_INCIDENTS.includes(user.role);
  if (canViewAll) {
    return incidents;
  }
  return incidents.filter(inc => 
    inc.reporterId === user.id || inc.currentHandlerId === user.id
  );
}

function sortIncidents(incidents, sortConfig) {
  if (!sortConfig) {
    return incidents.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }
  
  const { field, direction } = sortConfig;
  const multiplier = direction === SORT_DIRECTIONS.ASC ? 1 : -1;
  
  return incidents.sort((a, b) => {
    let valA, valB;
    
    if (field === SORT_FIELDS.LEVEL) {
      valA = LEVEL_ORDER[a.level] || 0;
      valB = LEVEL_ORDER[b.level] || 0;
    } else {
      valA = new Date(a[field] || 0).getTime();
      valB = new Date(b[field] || 0).getTime();
    }
    
    if (valA === valB) {
      return new Date(b.createdAt) - new Date(a.createdAt);
    }
    return (valA - valB) * multiplier;
  });
}

function getIncidentList(user, filters = {}) {
  validateFilters(filters);
  
  let incidents = incidentsStore.readAll();
  
  incidents = applyPermissionFilter(user, incidents);
  
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
  if (filters.assignedTo) {
    incidents = incidents.filter(inc => inc.currentHandlerId === filters.assignedTo);
  }
  if (filters.createdFrom) {
    const from = new Date(filters.createdFrom).getTime();
    incidents = incidents.filter(inc => new Date(inc.createdAt).getTime() >= from);
  }
  if (filters.createdTo) {
    const to = new Date(filters.createdTo).getTime();
    incidents = incidents.filter(inc => new Date(inc.createdAt).getTime() <= to);
  }
  if (filters.overdueOnly === 'true' || filters.overdueOnly === true) {
    incidents = incidents.filter(inc => isIncidentOverdue(inc));
  }
  
  const sortConfig = parseSortParam(filters.sort);
  incidents = sortIncidents(incidents, sortConfig);
  
  return incidents.map(inc => ({
    ...inc,
    overdue: isIncidentOverdue(inc)
  }));
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
    evidences: sortedEvidences,
    overdue: isIncidentOverdue(incident)
  };
}

function canTransitionStatus(currentStatus, targetStatus) {
  const allowed = INCIDENT_STATUS_FLOW[currentStatus];
  return allowed && allowed.includes(targetStatus);
}

function transitionStatus(user, incidentId, targetStatus, reason = null, allowReopen = false) {
  const incident = incidentsStore.findById(incidentId);
  if (!incident) {
    return { success: false, error: ERROR_CODES.NOT_FOUND };
  }

  if (incident.status === INCIDENT_STATUS.CLOSED) {
    const isLegalReopen = allowReopen && targetStatus === INCIDENT_STATUS.EVIDENCE_COLLECTING;
    if (!isLegalReopen) {
      return {
        success: false,
        error: ERROR_CODES.INCIDENT_CLOSED,
        details: {
          incidentId,
          currentStatus: incident.status,
          hint: '事故已结案，仅支持通过 reopen 接口重新打开'
        }
      };
    }
  } else if (!canTransitionStatus(incident.status, targetStatus)) {
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
  return transitionStatus(user, incidentId, INCIDENT_STATUS.EVIDENCE_COLLECTING, reason, true);
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
  canTransitionStatus,
  isIncidentOverdue
};
