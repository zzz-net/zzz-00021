const { incidentsStore, evidencesStore } = require('../storage');
const { getAuditLogs, logAction, AUDIT_ACTION } = require('./auditService');
const { getExportConfig } = require('./configService');
const { getAllReceiptPackagesForIncident, getReceiptRecordsByIncident } = require('./receiptService');
const { ERROR_CODES } = require('../constants/errors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

function toCSV(data, columns) {
  const header = columns.map(c => c.label).join(',');
  const rows = data.map(row =>
    columns.map(col => {
      let val = row[col.key];
      if (val === null || val === undefined) val = '';
      val = String(val);
      if (val.includes(',') || val.includes('"') || val.includes('\n')) {
        val = '"' + val.replace(/"/g, '""') + '"';
      }
      return val;
    }).join(',')
  );
  return [header, ...rows].join('\n');
}

function resolveSafeFilePath(targetDir, baseName, ext, strategy) {
  const basePath = path.join(targetDir, `${baseName}.${ext}`);
  if (!fs.existsSync(basePath)) {
    return { filePath: basePath, finalName: `${baseName}.${ext}`, conflict: false };
  }
  if (strategy === 'error') {
    return { conflict: true, existingPath: basePath };
  }
  let counter = 1;
  while (true) {
    const candidate = path.join(targetDir, `${baseName}-${counter}.${ext}`);
    if (!fs.existsSync(candidate)) {
      return { filePath: candidate, finalName: `${baseName}-${counter}.${ext}`, conflict: true, renamed: true };
    }
    counter++;
  }
}

function logExportFailure(user, type, incidentId, details, reason) {
  logAction(user.id, user.name, AUDIT_ACTION.DATA_EXPORT_FAILED, incidentId, {
    type,
    reason,
    ...details
  });
}

function exportIncidents(user, format = 'json') {
  const incidents = incidentsStore.readAll();
  const incidentsWithReceipts = incidents.map(inc => {
    const receiptPackages = getAllReceiptPackagesForIncident(inc.id);
    const pendingReceipt = receiptPackages.find(r => r.status === 'pending');
    const lastReceipt = receiptPackages.length > 0 ? receiptPackages[0] : null;
    return {
      ...inc,
      receiptPackageCount: receiptPackages.length,
      hasPendingReceipt: !!pendingReceipt,
      lastReceiptStatus: lastReceipt ? lastReceipt.status : null,
      lastReceiptCreatedAt: lastReceipt ? lastReceipt.createdAt : null,
      lastReceiptSignerName: lastReceipt ? lastReceipt.signerName : null
    };
  });

  logAction(user.id, user.name, AUDIT_ACTION.DATA_EXPORTED, null, {
    type: 'incidents',
    format,
    count: incidentsWithReceipts.length
  });

  if (format === 'csv') {
    const columns = [
      { key: 'id', label: 'ID' },
      { key: 'title', label: '标题' },
      { key: 'description', label: '描述' },
      { key: 'location', label: '地点' },
      { key: 'level', label: '级别' },
      { key: 'status', label: '状态' },
      { key: 'occurredAt', label: '发生时间' },
      { key: 'reporterName', label: '上报人' },
      { key: 'currentHandlerName', label: '当前处理人' },
      { key: 'evidenceCount', label: '证据数量' },
      { key: 'returnReason', label: '退回原因' },
      { key: 'receiptPackageCount', label: '签收包数量' },
      { key: 'hasPendingReceipt', label: '有待签收' },
      { key: 'lastReceiptStatus', label: '最新签收状态' },
      { key: 'lastReceiptCreatedAt', label: '最新签收创建时间' },
      { key: 'lastReceiptSignerName', label: '最新签收人' },
      { key: 'createdAt', label: '创建时间' },
      { key: 'updatedAt', label: '更新时间' }
    ];
    return { format, content: toCSV(incidentsWithReceipts, columns), filename: 'incidents.csv' };
  }

  return { format: 'json', content: JSON.stringify(incidentsWithReceipts, null, 2), filename: 'incidents.json' };
}

function exportEvidences(user, incidentId = null, format = 'json') {
  let evidences = evidencesStore.readAll();
  if (incidentId) {
    evidences = evidences.filter(e => e.incidentId === incidentId);
  }

  logAction(user.id, user.name, AUDIT_ACTION.DATA_EXPORTED, incidentId, {
    type: 'evidences',
    format,
    count: evidences.length
  });

  if (format === 'csv') {
    const columns = [
      { key: 'id', label: '证据ID' },
      { key: 'incidentId', label: '事故ID' },
      { key: 'type', label: '类型' },
      { key: 'description', label: '描述' },
      { key: 'collectedAt', label: '采集时间' },
      { key: 'collectorName', label: '采集人' },
      { key: 'filePath', label: '附件路径' },
      { key: 'fileHash', label: '文件哈希' },
      { key: 'createdAt', label: '创建时间' }
    ];
    return { format, content: toCSV(evidences, columns), filename: 'evidences.csv' };
  }

  return { format: 'json', content: JSON.stringify(evidences, null, 2), filename: 'evidences.json' };
}

function exportAuditLogs(user, filters = {}, format = 'json') {
  const logs = getAuditLogs(filters);

  logAction(user.id, user.name, AUDIT_ACTION.DATA_EXPORTED, null, {
    type: 'audit_logs',
    format,
    count: logs.length,
    filters
  });

  if (format === 'csv') {
    const columns = [
      { key: 'sequence', label: '序号' },
      { key: 'id', label: '日志ID' },
      { key: 'userId', label: '用户ID' },
      { key: 'userName', label: '用户名' },
      { key: 'action', label: '操作类型' },
      { key: 'incidentId', label: '关联事故ID' },
      { key: 'timestamp', label: '时间' },
      { key: 'details', label: '详情' }
    ];
    const flatLogs = logs.map(log => ({
      ...log,
      details: log.details ? JSON.stringify(log.details) : ''
    }));
    return { format, content: toCSV(flatLogs, columns), filename: 'audit_logs.csv' };
  }

  return { format: 'json', content: JSON.stringify(logs, null, 2), filename: 'audit_logs.json' };
}

function buildIncidentArchiveManifest(incident, evidences, auditLogs, receiptPackages, receiptRecords, format, filters, exportedAt, user) {
  return {
    schemaVersion: '1.0',
    exportedAt,
    exportId: uuidv4(),
    dataFormat: format,
    incidentId: incident.id,
    incidentTitle: incident.title,
    exportedBy: {
      userId: user ? user.id : null,
      userName: user ? user.name : null,
      userRole: user ? user.role : null
    },
    filters: filters || {},
    counts: {
      incidents: 1,
      evidences: evidences.length,
      auditLogs: auditLogs.length,
      receiptPackages: receiptPackages.length,
      receiptRecords: receiptRecords.length
    },
    files: [
      `incident.${format}`,
      `evidences.${format}`,
      `audit_logs.${format}`,
      `receipt_packages.${format}`,
      `receipt_records.${format}`,
      'manifest.json'
    ]
  };
}

function buildIncidentArchiveContent(incident, evidences, auditLogs, receiptPackages, receiptRecords, format, filters, user) {
  const exportedAt = new Date().toISOString();
  const manifest = buildIncidentArchiveManifest(incident, evidences, auditLogs, receiptPackages, receiptRecords, format, filters, exportedAt, user);

  if (format === 'csv') {
    const incidentColumns = [
      { key: 'id', label: 'ID' },
      { key: 'title', label: '标题' },
      { key: 'description', label: '描述' },
      { key: 'location', label: '地点' },
      { key: 'level', label: '级别' },
      { key: 'status', label: '状态' },
      { key: 'occurredAt', label: '发生时间' },
      { key: 'reporterName', label: '上报人' },
      { key: 'currentHandlerName', label: '当前处理人' },
      { key: 'evidenceCount', label: '证据数量' },
      { key: 'returnReason', label: '退回原因' },
      { key: 'createdAt', label: '创建时间' },
      { key: 'updatedAt', label: '更新时间' }
    ];
    const evidenceColumns = [
      { key: 'id', label: '证据ID' },
      { key: 'incidentId', label: '事故ID' },
      { key: 'type', label: '类型' },
      { key: 'description', label: '描述' },
      { key: 'collectedAt', label: '采集时间' },
      { key: 'collectorName', label: '采集人' },
      { key: 'filePath', label: '附件路径' },
      { key: 'fileHash', label: '文件哈希' },
      { key: 'createdAt', label: '创建时间' }
    ];
    const auditColumns = [
      { key: 'sequence', label: '序号' },
      { key: 'id', label: '日志ID' },
      { key: 'userId', label: '用户ID' },
      { key: 'userName', label: '用户名' },
      { key: 'action', label: '操作类型' },
      { key: 'incidentId', label: '关联事故ID' },
      { key: 'timestamp', label: '时间' },
      { key: 'details', label: '详情' }
    ];
    const receiptPackageColumns = [
      { key: 'id', label: '签收包ID' },
      { key: 'incidentId', label: '事故ID' },
      { key: 'status', label: '状态' },
      { key: 'deadline', label: '截止时间' },
      { key: 'creatorName', label: '创建人' },
      { key: 'receiverName', label: '接收人' },
      { key: 'signerName', label: '签收人' },
      { key: 'signedAt', label: '签收时间' },
      { key: 'revokedByName', label: '撤销人' },
      { key: 'revokedAt', label: '撤销时间' },
      { key: 'revokeReason', label: '撤销原因' },
      { key: 'exportFingerprint', label: '导出指纹' },
      { key: 'createdAt', label: '创建时间' }
    ];
    const receiptRecordColumns = [
      { key: 'id', label: '记录ID' },
      { key: 'receiptPackageId', label: '签收包ID' },
      { key: 'incidentId', label: '事故ID' },
      { key: 'action', label: '操作类型' },
      { key: 'operatorName', label: '操作人' },
      { key: 'timestamp', label: '时间' },
      { key: 'details', label: '详情' }
    ];
    const flatAuditLogs = auditLogs.map(log => ({
      ...log,
      details: log.details ? JSON.stringify(log.details) : ''
    }));
    const flatReceiptRecords = receiptRecords.map(r => ({
      ...r,
      details: r.details ? JSON.stringify(r.details) : ''
    }));

    return {
      manifest,
      files: {
        'manifest.json': JSON.stringify(manifest, null, 2),
        'incident.csv': toCSV([incident], incidentColumns),
        'evidences.csv': toCSV(evidences, evidenceColumns),
        'audit_logs.csv': toCSV(flatAuditLogs, auditColumns),
        'receipt_packages.csv': toCSV(receiptPackages, receiptPackageColumns),
        'receipt_records.csv': toCSV(flatReceiptRecords, receiptRecordColumns)
      }
    };
  }

  return {
    manifest,
    files: {
      'manifest.json': JSON.stringify(manifest, null, 2),
      'incident.json': JSON.stringify(incident, null, 2),
      'evidences.json': JSON.stringify(evidences, null, 2),
      'audit_logs.json': JSON.stringify(auditLogs, null, 2),
      'receipt_packages.json': JSON.stringify(receiptPackages, null, 2),
      'receipt_records.json': JSON.stringify(receiptRecords, null, 2)
    }
  };
}

function exportIncidentArchive(user, incidentId, format = 'json', options = {}) {
  const formatValid = format === 'csv' ? 'csv' : 'json';
  const incident = incidentsStore.findById(incidentId);

  if (!incident) {
    logExportFailure(user, 'incident_archive', incidentId, { format: formatValid }, 'incident not found');
    return {
      success: false,
      error: ERROR_CODES.NOT_FOUND,
      details: { incidentId }
    };
  }

  const evidences = evidencesStore.findMany(e => e.incidentId === incidentId)
    .sort((a, b) => new Date(a.collectedAt) - new Date(b.collectedAt));
  const auditLogs = getAuditLogs({ incidentId });
  const receiptPackages = getAllReceiptPackagesForIncident(incidentId);
  const receiptRecords = getReceiptRecordsByIncident(incidentId);

  const filters = { incidentId, format: formatValid };
  const { manifest, files } = buildIncidentArchiveContent(incident, evidences, auditLogs, receiptPackages, receiptRecords, formatValid, filters, user);

  if (options.downloadOnly) {
    logAction(user.id, user.name, AUDIT_ACTION.DATA_EXPORTED, incidentId, {
      type: 'incident_archive',
      format: formatValid,
      delivery: 'download',
      count: manifest.counts
    });
    return {
      success: true,
      data: {
        manifest,
        files,
        archiveName: `${manifest.exportId}-incident-${incidentId}-${formatValid}`
      }
    };
  }

  const config = getExportConfig();
  const dateStr = new Date().toISOString().slice(0, 10);
  const baseName = `${config.filenamePrefix}-${dateStr}-incident-${incidentId}-${formatValid}`;
  const resolved = resolveSafeFilePath(config.exportDir, baseName, 'json', config.conflictStrategy);

  if (resolved.conflict && !resolved.renamed) {
    logExportFailure(user, 'incident_archive', incidentId, {
      format: formatValid,
      targetPath: resolved.existingPath
    }, 'file conflict');
    return {
      success: false,
      error: ERROR_CODES.EXPORT_CONFLICT,
      details: {
        existingPath: resolved.existingPath,
        strategy: config.conflictStrategy
      }
    };
  }

  const archivePayload = {
    manifest,
    files
  };

  try {
    fs.writeFileSync(resolved.filePath, JSON.stringify(archivePayload, null, 2), 'utf-8');
  } catch (err) {
    logExportFailure(user, 'incident_archive', incidentId, {
      format: formatValid,
      targetPath: resolved.filePath
    }, err.message);
    return {
      success: false,
      error: ERROR_CODES.EXPORT_FAILED,
      details: { message: err.message, targetPath: resolved.filePath }
    };
  }

  logAction(user.id, user.name, AUDIT_ACTION.DATA_EXPORTED, incidentId, {
    type: 'incident_archive',
    format: formatValid,
    delivery: 'file',
    savedPath: resolved.filePath,
    finalName: resolved.finalName,
    renamed: resolved.renamed || false,
    count: manifest.counts
  });

  return {
    success: true,
    data: {
      manifest,
      savedPath: resolved.filePath,
      finalName: resolved.finalName,
      renamed: resolved.renamed || false,
      files: Object.keys(files)
    }
  };
}

function listSavedExports() {
  const config = getExportConfig();
  if (!fs.existsSync(config.exportDir)) {
    return [];
  }
  const entries = fs.readdirSync(config.exportDir, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.json')) {
      const fullPath = path.join(config.exportDir, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        const raw = fs.readFileSync(fullPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed.manifest) {
          result.push({
            filename: entry.name,
            fullPath,
            size: stat.size,
            mtime: stat.mtime.toISOString(),
            manifest: parsed.manifest
          });
        }
      } catch {
      }
    }
  }
  return result.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
}

module.exports = {
  exportIncidents,
  exportEvidences,
  exportAuditLogs,
  exportIncidentArchive,
  listSavedExports,
  toCSV
};
