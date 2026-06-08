const { v4: uuidv4 } = require('uuid');
const { incidentsStore, evidencesStore } = require('../storage');
const { ERROR_CODES } = require('../constants/errors');
const { logAction, AUDIT_ACTION } = require('./auditService');

function addEvidence(user, incidentId, data) {
  const incident = incidentsStore.findById(incidentId);
  if (!incident) {
    return { success: false, error: ERROR_CODES.NOT_FOUND };
  }

  const collectedAt = data.collectedAt || new Date().toISOString();
  
  if (new Date(collectedAt) < new Date(incident.occurredAt)) {
    return { 
      success: false, 
      error: ERROR_CODES.EVIDENCE_TIME_TOO_EARLY,
      details: {
        evidenceCollectedAt: collectedAt,
        incidentOccurredAt: incident.occurredAt
      }
    };
  }

  const existingEvidences = evidencesStore.findMany(e => e.incidentId === incidentId);
  if (data.fileHash) {
    const duplicate = existingEvidences.find(e => e.fileHash === data.fileHash);
    if (duplicate) {
      return {
        success: false,
        error: ERROR_CODES.DUPLICATE_EVIDENCE_HASH,
        details: {
          duplicateEvidenceId: duplicate.id,
          fileHash: data.fileHash
        }
      };
    }
  }

  const now = new Date().toISOString();
  const evidence = {
    id: uuidv4(),
    incidentId,
    type: data.type || 'other',
    description: data.description,
    collectedAt,
    collectorId: user.id,
    collectorName: user.name,
    filePath: data.filePath || null,
    fileHash: data.fileHash || null,
    createdAt: now
  };

  evidencesStore.append(evidence);

  const evidenceCount = evidencesStore.findMany(e => e.incidentId === incidentId).length;
  incidentsStore.updateById(incidentId, inc => ({
    ...inc,
    evidenceCount,
    updatedAt: now
  }));

  logAction(user.id, user.name, AUDIT_ACTION.EVIDENCE_ADDED, incidentId, {
    evidenceId: evidence.id,
    type: evidence.type,
    fileHash: evidence.fileHash
  });

  return { success: true, data: evidence };
}

function getEvidencesByIncident(incidentId) {
  const evidences = evidencesStore.findMany(e => e.incidentId === incidentId);
  return evidences.sort((a, b) => new Date(a.collectedAt) - new Date(b.collectedAt));
}

function getEvidenceById(id) {
  return evidencesStore.findById(id);
}

module.exports = {
  addEvidence,
  getEvidencesByIncident,
  getEvidenceById
};
