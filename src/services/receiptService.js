const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { incidentsStore, evidencesStore, receiptPackagesStore, receiptRecordsStore } = require('../storage');
const { INCIDENT_STATUS, RECEIPT_PACKAGE_STATUS, RECEIPT_CONFLICT_STRATEGY, AUDIT_ACTION } = require('../constants/status');
const { ERROR_CODES } = require('../constants/errors');
const { logAction, getAuditLogs } = require('./auditService');
const { getDb } = require('../storage/sqliteStore');

function generateReceiptCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function hashCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function appendReceiptRecord(packageId, incidentId, action, operator, details = {}) {
  const record = {
    id: `rec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    receiptPackageId: packageId,
    incidentId,
    action,
    operatorId: operator.id,
    operatorName: operator.name,
    details,
    timestamp: new Date().toISOString()
  };
  receiptRecordsStore.append(record);
  return record;
}

function findPendingPackageByIncident(incidentId) {
  const all = receiptPackagesStore.findMany(p =>
    p.incidentId === incidentId && p.status === RECEIPT_PACKAGE_STATUS.PENDING
  );
  return all.length > 0 ? all[0] : null;
}

function computeExportFingerprint(incident, evidences, auditLogs) {
  const payload = JSON.stringify({
    incident: { id: incident.id, title: incident.title, status: incident.status, updatedAt: incident.updatedAt },
    evidences: evidences.map(e => ({ id: e.id, fileHash: e.fileHash, collectedAt: e.collectedAt })),
    auditCount: auditLogs.length
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function createReceiptPackage(user, incidentId, options = {}) {
  const db = getDb();
  const now = new Date().toISOString();
  const strategy = RECEIPT_CONFLICT_STRATEGY.SUPERSEDE === options.conflictStrategy
    ? RECEIPT_CONFLICT_STRATEGY.SUPERSEDE
    : RECEIPT_CONFLICT_STRATEGY.ERROR;

  const deadlineHours = typeof options.deadlineHours === 'number' && options.deadlineHours > 0
    ? options.deadlineHours
    : 72;
  const deadline = new Date(Date.now() + deadlineHours * 3600 * 1000).toISOString();
  const receiverName = typeof options.receiverName === 'string' ? options.receiverName : null;

  const incident = incidentsStore.findById(incidentId);
  if (!incident) {
    logAction(user.id, user.name, AUDIT_ACTION.RECEIPT_CREATE_FAILED, null, {
      reason: 'incident_not_found',
      incidentId
    });
    return { success: false, error: ERROR_CODES.NOT_FOUND, details: { incidentId } };
  }

  if (incident.status !== INCIDENT_STATUS.CLOSED) {
    logAction(user.id, user.name, AUDIT_ACTION.RECEIPT_CREATE_FAILED, incidentId, {
      reason: 'incident_not_closed',
      currentStatus: incident.status
    });
    return {
      success: false,
      error: ERROR_CODES.RECEIPT_INCIDENT_NOT_CLOSED,
      details: { incidentId, currentStatus: incident.status }
    };
  }

  const evidences = evidencesStore.findMany(e => e.incidentId === incidentId);
  if (!evidences || evidences.length === 0) {
    logAction(user.id, user.name, AUDIT_ACTION.RECEIPT_CREATE_FAILED, incidentId, {
      reason: 'no_evidence'
    });
    return {
      success: false,
      error: ERROR_CODES.RECEIPT_NO_EVIDENCE,
      details: { incidentId }
    };
  }

  const existingPending = findPendingPackageByIncident(incidentId);
  if (existingPending) {
    if (strategy === RECEIPT_CONFLICT_STRATEGY.ERROR) {
      logAction(user.id, user.name, AUDIT_ACTION.RECEIPT_CREATE_FAILED, incidentId, {
        reason: 'conflict_pending_exists',
        strategy,
        existingPackageId: existingPending.id
      });
      return {
        success: false,
        error: ERROR_CODES.RECEIPT_CONFLICT,
        details: {
          incidentId,
          existingPackageId: existingPending.id,
          strategy,
          hint: '该事故已有未完成的签收包，可使用 conflictStrategy=supersede 自动作废旧包'
        }
      };
    }
  }

  const auditLogs = getAuditLogs({ incidentId });
  const incidentSnapshot = {
    id: incident.id,
    title: incident.title,
    description: incident.description,
    location: incident.location,
    level: incident.level,
    occurredAt: incident.occurredAt,
    status: incident.status,
    reporterId: incident.reporterId,
    reporterName: incident.reporterName,
    closedAt: incident.updatedAt,
    evidenceCount: incident.evidenceCount
  };

  const evidenceSummary = evidences.map(e => ({
    id: e.id,
    type: e.type,
    description: e.description,
    collectedAt: e.collectedAt,
    collectorId: e.collectorId,
    collectorName: e.collectorName,
    fileHash: e.fileHash,
    filePath: e.filePath
  }));

  const auditSummary = auditLogs.map(l => ({
    sequence: l.sequence,
    action: l.action,
    userId: l.userId,
    userName: l.userName,
    timestamp: l.timestamp
  }));

  const exportFingerprint = computeExportFingerprint(incident, evidences, auditLogs);
  const receiptCode = generateReceiptCode();
  const codeHash = hashCode(receiptCode);

  const packageId = uuidv4();

  const tx = db.transaction(() => {
    if (existingPending && strategy === RECEIPT_CONFLICT_STRATEGY.SUPERSEDE) {
      receiptPackagesStore.updateById(existingPending.id, (p) => ({
        ...p,
        status: RECEIPT_PACKAGE_STATUS.REVOKED,
        revokedById: user.id,
        revokedByName: user.name,
        revokedAt: now,
        revokeReason: `被新签收包 ${packageId} 自动作废`,
        supersededById: packageId,
        updatedAt: now
      }));
      appendReceiptRecord(existingPending.id, incidentId, 'superseded', user, {
        supersededBy: packageId,
        reason: 'automatic_supersede'
      });
    }

    const pkg = {
      id: packageId,
      incidentId,
      status: RECEIPT_PACKAGE_STATUS.PENDING,
      receiptCode,
      codeHash,
      deadline,
      creatorId: user.id,
      creatorName: user.name,
      incidentSnapshot,
      evidenceSummary,
      auditSummary,
      exportFingerprint,
      receiverName,
      signerId: null,
      signerName: null,
      signedAt: null,
      revokedById: null,
      revokedByName: null,
      revokedAt: null,
      revokeReason: null,
      supersededById: null,
      createdAt: now,
      updatedAt: now
    };
    receiptPackagesStore.append(pkg);
    appendReceiptRecord(packageId, incidentId, 'created', user, {
      strategy,
      deadlineHours,
      receiverName,
      supersededOld: !!existingPending
    });
    return pkg;
  });

  try {
    const created = tx();
    logAction(user.id, user.name, AUDIT_ACTION.RECEIPT_CREATED, incidentId, {
      receiptPackageId: packageId,
      strategy,
      deadline,
      receiverName,
      supersededOld: !!existingPending,
      supersededPackageId: existingPending ? existingPending.id : null
    });
    return {
      success: true,
      data: {
        id: created.id,
        incidentId: created.incidentId,
        status: created.status,
        receiptCode: created.receiptCode,
        deadline: created.deadline,
        creatorId: created.creatorId,
        creatorName: created.creatorName,
        receiverName: created.receiverName,
        incidentSnapshot: created.incidentSnapshot,
        evidenceSummary: created.evidenceSummary,
        auditSummary: created.auditSummary,
        exportFingerprint: created.exportFingerprint,
        evidenceCount: created.evidenceSummary.length,
        auditLogCount: created.auditSummary.length,
        createdAt: created.createdAt,
        supersededOld: !!existingPending,
        supersededPackageId: existingPending ? existingPending.id : null
      }
    };
  } catch (err) {
    logAction(user.id, user.name, AUDIT_ACTION.RECEIPT_CREATE_FAILED, incidentId, {
      reason: 'transaction_error',
      message: err.message
    });
    return {
      success: false,
      error: ERROR_CODES.RECEIPT_CREATE_FAILED,
      details: { message: err.message }
    };
  }
}

function getReceiptPackage(user, packageId) {
  const pkg = receiptPackagesStore.findById(packageId);
  if (!pkg) {
    return { success: false, error: ERROR_CODES.RECEIPT_NOT_FOUND, details: { packageId } };
  }
  const now = new Date().toISOString();
  let effectiveStatus = pkg.status;
  if (pkg.status === RECEIPT_PACKAGE_STATUS.PENDING && pkg.deadline < now) {
    effectiveStatus = RECEIPT_PACKAGE_STATUS.EXPIRED;
  }
  const records = receiptRecordsStore.findMany(r => r.receiptPackageId === packageId)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  logAction(user.id, user.name, AUDIT_ACTION.RECEIPT_VIEWED, pkg.incidentId, {
    receiptPackageId: packageId
  });

  return {
    success: true,
    data: {
      id: pkg.id,
      incidentId: pkg.incidentId,
      status: effectiveStatus,
      deadline: pkg.deadline,
      creatorId: pkg.creatorId,
      creatorName: pkg.creatorName,
      receiverName: pkg.receiverName,
      incidentSnapshot: pkg.incidentSnapshot,
      evidenceSummary: pkg.evidenceSummary,
      auditSummary: pkg.auditSummary,
      exportFingerprint: pkg.exportFingerprint,
      signerId: pkg.signerId,
      signerName: pkg.signerName,
      signedAt: pkg.signedAt,
      revokedById: pkg.revokedById,
      revokedByName: pkg.revokedByName,
      revokedAt: pkg.revokedAt,
      revokeReason: pkg.revokeReason,
      supersededById: pkg.supersededById,
      createdAt: pkg.createdAt,
      updatedAt: pkg.updatedAt,
      records
    }
  };
}

function listReceiptPackages(user, filters = {}) {
  let packages = receiptPackagesStore.readAll();
  const now = new Date().toISOString();

  if (filters.incidentId) {
    packages = packages.filter(p => p.incidentId === filters.incidentId);
  }
  if (filters.status) {
    if (filters.status === RECEIPT_PACKAGE_STATUS.EXPIRED) {
      packages = packages.filter(p =>
        (p.status === RECEIPT_PACKAGE_STATUS.PENDING && p.deadline < now)
      );
    } else {
      packages = packages.filter(p => p.status === filters.status);
    }
  }
  if (filters.creatorId) {
    packages = packages.filter(p => p.creatorId === filters.creatorId);
  }

  const result = packages.map(p => {
    let effectiveStatus = p.status;
    if (p.status === RECEIPT_PACKAGE_STATUS.PENDING && p.deadline < now) {
      effectiveStatus = RECEIPT_PACKAGE_STATUS.EXPIRED;
    }
    return {
      id: p.id,
      incidentId: p.incidentId,
      status: effectiveStatus,
      deadline: p.deadline,
      creatorId: p.creatorId,
      creatorName: p.creatorName,
      receiverName: p.receiverName,
      signerName: p.signerName,
      signedAt: p.signedAt,
      revokedByName: p.revokedByName,
      revokedAt: p.revokedAt,
      exportFingerprint: p.exportFingerprint,
      createdAt: p.createdAt
    };
  });

  return {
    success: true,
    data: result.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  };
}

function getReceiptPackageByCode(code) {
  if (!code || typeof code !== 'string' || code.length === 0) {
    return {
      success: false,
      error: ERROR_CODES.RECEIPT_INVALID_CODE,
      details: { reason: '签收码为空' }
    };
  }
  const codeHash = hashCode(code.trim().toUpperCase());
  const matches = receiptPackagesStore.findMany(p => p.codeHash === codeHash);
  if (matches.length === 0) {
    return {
      success: false,
      error: ERROR_CODES.RECEIPT_INVALID_CODE,
      details: { reason: '签收码不存在' }
    };
  }
  const pkg = matches[0];
  const now = new Date().toISOString();
  let effectiveStatus = pkg.status;
  if (pkg.status === RECEIPT_PACKAGE_STATUS.PENDING && pkg.deadline < now) {
    effectiveStatus = RECEIPT_PACKAGE_STATUS.EXPIRED;
  }
  return {
    success: true,
    data: {
      id: pkg.id,
      incidentId: pkg.incidentId,
      status: effectiveStatus,
      deadline: pkg.deadline,
      creatorId: pkg.creatorId,
      creatorName: pkg.creatorName,
      receiverName: pkg.receiverName,
      incidentSnapshot: pkg.incidentSnapshot,
      evidenceSummary: pkg.evidenceSummary,
      auditSummary: pkg.auditSummary,
      exportFingerprint: pkg.exportFingerprint,
      signerName: pkg.signerName,
      signedAt: pkg.signedAt,
      revokedByName: pkg.revokedByName,
      revokedAt: pkg.revokedAt,
      revokeReason: pkg.revokeReason,
      createdAt: pkg.createdAt
    }
  };
}

function signReceiptPackage(user, code, signerInfo = {}) {
  if (!code || typeof code !== 'string' || code.length === 0) {
    logAction(user.id, user.name, AUDIT_ACTION.RECEIPT_SIGN_FAILED, null, {
      reason: 'empty_code'
    });
    return {
      success: false,
      error: ERROR_CODES.RECEIPT_INVALID_CODE,
      details: { reason: '签收码不能为空' }
    };
  }

  const trimmedCode = code.trim().toUpperCase();
  const codeHash = hashCode(trimmedCode);
  const matches = receiptPackagesStore.findMany(p => p.codeHash === codeHash);

  if (matches.length === 0) {
    logAction(user.id, user.name, AUDIT_ACTION.RECEIPT_SIGN_FAILED, null, {
      reason: 'code_not_found',
      codePrefix: trimmedCode.substring(0, 3) + '***'
    });
    return {
      success: false,
      error: ERROR_CODES.RECEIPT_INVALID_CODE,
      details: { reason: '签收码无效或不存在' }
    };
  }

  const pkg = matches[0];
  const now = new Date().toISOString();

  if (pkg.status === RECEIPT_PACKAGE_STATUS.SIGNED) {
    logAction(user.id, user.name, AUDIT_ACTION.RECEIPT_SIGN_FAILED, pkg.incidentId, {
      reason: 'already_signed',
      receiptPackageId: pkg.id
    });
    return {
      success: false,
      error: ERROR_CODES.RECEIPT_ALREADY_SIGNED,
      details: {
        receiptPackageId: pkg.id,
        signerName: pkg.signerName,
        signedAt: pkg.signedAt
      }
    };
  }

  if (pkg.status === RECEIPT_PACKAGE_STATUS.REVOKED) {
    logAction(user.id, user.name, AUDIT_ACTION.RECEIPT_SIGN_FAILED, pkg.incidentId, {
      reason: 'revoked',
      receiptPackageId: pkg.id
    });
    return {
      success: false,
      error: ERROR_CODES.RECEIPT_REVOKED,
      details: {
        receiptPackageId: pkg.id,
        revokedByName: pkg.revokedByName,
        revokedAt: pkg.revokedAt,
        revokeReason: pkg.revokeReason
      }
    };
  }

  if (pkg.status === RECEIPT_PACKAGE_STATUS.PENDING && pkg.deadline < now) {
    logAction(user.id, user.name, AUDIT_ACTION.RECEIPT_SIGN_FAILED, pkg.incidentId, {
      reason: 'expired',
      receiptPackageId: pkg.id,
      deadline: pkg.deadline
    });
    return {
      success: false,
      error: ERROR_CODES.RECEIPT_EXPIRED,
      details: {
        receiptPackageId: pkg.id,
        deadline: pkg.deadline,
        currentTime: now
      }
    };
  }

  const signerName = (signerInfo.signerName && typeof signerInfo.signerName === 'string')
    ? signerInfo.signerName
    : user.name;

  const db = getDb();
  const tx = db.transaction(() => {
    const updated = receiptPackagesStore.updateById(pkg.id, (p) => ({
      ...p,
      status: RECEIPT_PACKAGE_STATUS.SIGNED,
      signerId: user.id,
      signerName,
      signedAt: now,
      updatedAt: now
    }));
    appendReceiptRecord(pkg.id, pkg.incidentId, 'signed', user, {
      signerName,
      signerProvided: !!signerInfo.signerName
    });
    return updated;
  });

  try {
    const result = tx();
    logAction(user.id, user.name, AUDIT_ACTION.RECEIPT_SIGNED, pkg.incidentId, {
      receiptPackageId: pkg.id,
      signerName,
      signedAt: now
    });
    return {
      success: true,
      data: {
        id: result.id,
        incidentId: result.incidentId,
        status: result.status,
        signerId: result.signerId,
        signerName: result.signerName,
        signedAt: result.signedAt
      }
    };
  } catch (err) {
    logAction(user.id, user.name, AUDIT_ACTION.RECEIPT_SIGN_FAILED, pkg.incidentId, {
      reason: 'transaction_error',
      receiptPackageId: pkg.id,
      message: err.message
    });
    return {
      success: false,
      error: ERROR_CODES.RECEIPT_SIGN_FAILED,
      details: { message: err.message, receiptPackageId: pkg.id }
    };
  }
}

function revokeReceiptPackage(user, packageId, reason = null) {
  const pkg = receiptPackagesStore.findById(packageId);
  if (!pkg) {
    logAction(user.id, user.name, AUDIT_ACTION.RECEIPT_REVOKE_FAILED, null, {
      reason: 'package_not_found',
      packageId
    });
    return { success: false, error: ERROR_CODES.RECEIPT_NOT_FOUND, details: { packageId } };
  }

  if (pkg.status === RECEIPT_PACKAGE_STATUS.REVOKED) {
    logAction(user.id, user.name, AUDIT_ACTION.RECEIPT_REVOKE_FAILED, pkg.incidentId, {
      reason: 'already_revoked',
      receiptPackageId: packageId
    });
    return {
      success: false,
      error: ERROR_CODES.RECEIPT_REVOKED,
      details: {
        receiptPackageId: packageId,
        revokedByName: pkg.revokedByName,
        revokedAt: pkg.revokedAt
      }
    };
  }

  if (pkg.status === RECEIPT_PACKAGE_STATUS.SIGNED) {
    logAction(user.id, user.name, AUDIT_ACTION.RECEIPT_REVOKE_FAILED, pkg.incidentId, {
      reason: 'already_signed',
      receiptPackageId: packageId
    });
    return {
      success: false,
      error: ERROR_CODES.RECEIPT_ALREADY_SIGNED,
      details: {
        receiptPackageId: packageId,
        signerName: pkg.signerName,
        signedAt: pkg.signedAt,
        hint: '已完成签收的包无法撤销'
      }
    };
  }

  const now = new Date().toISOString();
  const db = getDb();
  const tx = db.transaction(() => {
    const updated = receiptPackagesStore.updateById(packageId, (p) => ({
      ...p,
      status: RECEIPT_PACKAGE_STATUS.REVOKED,
      revokedById: user.id,
      revokedByName: user.name,
      revokedAt: now,
      revokeReason: reason || '手动撤销',
      updatedAt: now
    }));
    appendReceiptRecord(packageId, pkg.incidentId, 'revoked', user, {
      reason: reason || 'manual_revoke'
    });
    return updated;
  });

  try {
    const result = tx();
    logAction(user.id, user.name, AUDIT_ACTION.RECEIPT_REVOKED, pkg.incidentId, {
      receiptPackageId: packageId,
      reason: reason || 'manual_revoke'
    });
    return {
      success: true,
      data: {
        id: result.id,
        incidentId: result.incidentId,
        status: result.status,
        revokedById: result.revokedById,
        revokedByName: result.revokedByName,
        revokedAt: result.revokedAt,
        revokeReason: result.revokeReason
      }
    };
  } catch (err) {
    logAction(user.id, user.name, AUDIT_ACTION.RECEIPT_REVOKE_FAILED, pkg.incidentId, {
      reason: 'transaction_error',
      receiptPackageId: packageId,
      message: err.message
    });
    return {
      success: false,
      error: ERROR_CODES.RECEIPT_REVOKE_FAILED,
      details: { message: err.message, receiptPackageId: packageId }
    };
  }
}

function getReceiptRecordsByIncident(incidentId) {
  return receiptRecordsStore.findMany(r => r.incidentId === incidentId)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

function getAllReceiptPackagesForIncident(incidentId) {
  const packages = receiptPackagesStore.findMany(p => p.incidentId === incidentId);
  const now = new Date().toISOString();
  return packages.map(p => {
    let effectiveStatus = p.status;
    if (p.status === RECEIPT_PACKAGE_STATUS.PENDING && p.deadline < now) {
      effectiveStatus = RECEIPT_PACKAGE_STATUS.EXPIRED;
    }
    return {
      id: p.id,
      status: effectiveStatus,
      deadline: p.deadline,
      creatorName: p.creatorName,
      receiverName: p.receiverName,
      signerName: p.signerName,
      signedAt: p.signedAt,
      revokedByName: p.revokedByName,
      revokedAt: p.revokedAt,
      exportFingerprint: p.exportFingerprint,
      createdAt: p.createdAt
    };
  }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

module.exports = {
  createReceiptPackage,
  getReceiptPackage,
  listReceiptPackages,
  getReceiptPackageByCode,
  signReceiptPackage,
  revokeReceiptPackage,
  getReceiptRecordsByIncident,
  getAllReceiptPackagesForIncident,
  generateReceiptCode,
  hashCode
};
