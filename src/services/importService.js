const { v4: uuidv4 } = require('uuid');
const { incidentsStore, evidencesStore, auditLogsStore, receiptPackagesStore, receiptRecordsStore } = require('../storage');
const { getDb } = require('../storage/sqliteStore');
const { logAction, AUDIT_ACTION } = require('./auditService');
const { getExportConfig } = require('./configService');
const { ERROR_CODES } = require('../constants/errors');
const { RECEIPT_PACKAGE_STATUS } = require('../constants/status');
const path = require('path');
const fs = require('fs');

function isPathWithinDir(filePath, dirPath) {
  const resolvedFile = path.resolve(filePath);
  const resolvedDir = path.resolve(dirPath);
  const sep = path.sep;
  const normalizedDir = resolvedDir.endsWith(sep) ? resolvedDir : resolvedDir + sep;
  return resolvedFile === resolvedDir || resolvedFile.startsWith(normalizedDir);
}

function resolveArchiveFilePath(filename) {
  const config = getExportConfig();
  const resolvedExportDir = path.resolve(config.exportDir);
  const rawPath = path.isAbsolute(filename)
    ? path.resolve(filename)
    : path.resolve(resolvedExportDir, filename);
  return {
    exportDir: resolvedExportDir, rawPath, config };
}

function validateArchiveFileAccess(user, filename) {
  const { exportDir, rawPath } = resolveArchiveFilePath(filename);

  if (!isPathWithinDir(rawPath, exportDir)) {
    return {
      success: false,
      error: ERROR_CODES.IMPORT_VALIDATION_ERROR,
      details: {
        reason: '归档文件路径不在配置的导出目录范围内',
        hint: '仅允许读取 exportDir 配置目录（含子目录）下的归档文件；不可使用 ../ 等路径穿越到上级目录，也不可读取同前缀的兄弟目录',
        requestedPath: filename,
        requestedResolved: rawPath,
        exportDir
      },
      auditReason: 'path_outside_export_dir',
      auditDetails: { requestedPath: filename, requestedResolved: rawPath, exportDir }
    };
  }

  let stat;
  try {
    stat = fs.statSync(rawPath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {
        success: false,
        error: ERROR_CODES.NOT_FOUND,
        details: {
          reason: '归档文件不存在',
          filePath: rawPath
        },
        auditReason: 'file_not_found',
        auditDetails: { filePath: rawPath }
      };
    }
    return {
      success: false,
      error: ERROR_CODES.IMPORT_FAILED,
      details: {
        reason: '无法访问归档文件',
        filePath: rawPath,
        message: err.message
      },
      auditReason: 'file_stat_error',
      auditDetails: { filePath: rawPath, message: err.message }
    };
  }

  if (!stat.isFile()) {
    return {
      success: false,
      error: ERROR_CODES.IMPORT_VALIDATION_ERROR,
      details: {
        reason: '目标路径不是普通文件',
        filePath: rawPath,
        isDirectory: stat.isDirectory()
      },
      auditReason: 'path_not_a_file',
      auditDetails: { filePath: rawPath, isDirectory: stat.isDirectory() }
    };
  }

  try {
    fs.accessSync(rawPath, fs.constants.R_OK);
  } catch (err) {
    return {
      success: false,
      error: ERROR_CODES.IMPORT_FAILED,
      details: {
        reason: '无读取权限',
        filePath: rawPath
      },
      auditReason: 'file_read_permission_denied',
      auditDetails: { filePath: rawPath }
    };
  }

  return { success: true, filePath: rawPath, exportDir };
}

const REQUIRED_FILES = ['manifest.json', 'incident.json', 'evidences.json', 'audit_logs.json'];
const SUPPORTED_SCHEMA_VERSIONS = ['1.0'];
const SUPPORTED_DATA_FORMATS = ['json'];
const CONFLICT_STRATEGIES = ['skip', 'newId'];

function parseJSONSafe(str) {
  try {
    return { success: true, data: JSON.parse(str) };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function validateArchiveStructure(archive) {
  const errors = [];

  if (!archive || typeof archive !== 'object') {
    errors.push('归档内容不是有效的 JSON 对象');
    return errors;
  }

  if (!archive.manifest || typeof archive.manifest !== 'object') {
    errors.push('缺少 manifest 字段或格式不正确');
  }

  if (!archive.files || typeof archive.files !== 'object') {
    errors.push('缺少 files 字段或格式不正确');
    return errors;
  }

  for (const required of REQUIRED_FILES) {
    if (!archive.files[required] || typeof archive.files[required] !== 'string') {
      errors.push(`缺少文件内容: ${required}`);
    }
  }

  return errors;
}

function validateManifest(manifest, incident, evidences, auditLogs) {
  const errors = [];

  if (!SUPPORTED_SCHEMA_VERSIONS.includes(manifest.schemaVersion)) {
    errors.push(`不支持的 schemaVersion: ${manifest.schemaVersion}，支持: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}`);
  }

  if (!SUPPORTED_DATA_FORMATS.includes(manifest.dataFormat)) {
    errors.push(`不支持的 dataFormat: ${manifest.dataFormat}，仅支持 json 格式归档导入`);
  }

  if (!manifest.exportId) {
    errors.push('manifest.exportId 缺失');
  }

  if (!manifest.incidentId) {
    errors.push('manifest.incidentId 缺失');
  }

  if (!manifest.exportedAt) {
    errors.push('manifest.exportedAt 缺失');
  }

  if (!manifest.files || !Array.isArray(manifest.files)) {
    errors.push('manifest.files 缺失或不是数组');
  } else {
    for (const required of REQUIRED_FILES) {
      if (!manifest.files.includes(required)) {
        errors.push(`manifest.files 中未列出: ${required}`);
      }
    }
  }

  if (manifest.counts) {
    if (manifest.counts.incidents !== 1) {
      errors.push(`manifest.counts.incidents 应为 1，实际: ${manifest.counts.incidents}`);
    }
    if (manifest.counts.evidences !== evidences.length) {
      errors.push(`manifest.counts.evidences=${manifest.counts.evidences} 与实际 evidences 数量 ${evidences.length} 不匹配`);
    }
    if (manifest.counts.auditLogs !== auditLogs.length) {
      errors.push(`manifest.counts.auditLogs=${manifest.counts.auditLogs} 与实际 auditLogs 数量 ${auditLogs.length} 不匹配`);
    }
  }

  if (incident && manifest.incidentId && incident.id !== manifest.incidentId) {
    errors.push(`incident.id=${incident.id} 与 manifest.incidentId=${manifest.incidentId} 不匹配`);
  }

  if (Array.isArray(evidences)) {
    for (let i = 0; i < evidences.length; i++) {
      const ev = evidences[i];
      if (manifest.incidentId && ev.incidentId !== manifest.incidentId) {
        errors.push(`evidence[${i}].incidentId=${ev.incidentId} 与 manifest.incidentId=${manifest.incidentId} 不匹配`);
      }
    }
  }

  return errors;
}

function validateIncidentData(incident) {
  const errors = [];
  if (!incident || typeof incident !== 'object') {
    errors.push('incident.json 内容不是有效的对象');
    return errors;
  }
  const required = ['id', 'title', 'location', 'level', 'occurredAt', 'status', 'reporterId', 'reporterName'];
  for (const key of required) {
    if (incident[key] === undefined || incident[key] === null || incident[key] === '') {
      if (key !== 'returnReason') {
        errors.push(`incident.${key} 缺失或为空`);
      }
    }
  }
  return errors;
}

function validateEvidencesData(evidences) {
  const errors = [];
  if (!Array.isArray(evidences)) {
    errors.push('evidences.json 内容不是数组');
    return errors;
  }
  for (let i = 0; i < evidences.length; i++) {
    const ev = evidences[i];
    if (!ev || typeof ev !== 'object') {
      errors.push(`evidence[${i}] 不是对象`);
      continue;
    }
    if (!ev.id) errors.push(`evidence[${i}].id 缺失`);
    if (!ev.incidentId) errors.push(`evidence[${i}].incidentId 缺失`);
    if (!ev.collectedAt) errors.push(`evidence[${i}].collectedAt 缺失`);
  }
  return errors;
}

function validateAuditLogsData(auditLogs) {
  const errors = [];
  if (!Array.isArray(auditLogs)) {
    errors.push('audit_logs.json 内容不是数组');
    return errors;
  }
  for (let i = 0; i < auditLogs.length; i++) {
    const log = auditLogs[i];
    if (!log || typeof log !== 'object') {
      errors.push(`audit_logs[${i}] 不是对象`);
      continue;
    }
    if (!log.id) errors.push(`audit_logs[${i}].id 缺失`);
    if (!log.action) errors.push(`audit_logs[${i}].action 缺失`);
    if (!log.userId) errors.push(`audit_logs[${i}].userId 缺失`);
    if (!log.timestamp) errors.push(`audit_logs[${i}].timestamp 缺失`);
  }
  return errors;
}

function checkIncidentConflict(incidentId) {
  const existing = incidentsStore.findById(incidentId);
  return { exists: !!existing, existing };
}

function buildRemapPlan(manifest, incident, evidences, auditLogs, receiptPackages, receiptRecords, strategy) {
  const plan = {
    strategy,
    oldIncidentId: manifest.incidentId,
    newIncidentId: null,
    incidentData: null,
    evidences: [],
    auditLogs: [],
    receiptPackages: [],
    receiptRecords: [],
    skipped: false,
    skipReason: null
  };

  const conflict = checkIncidentConflict(manifest.incidentId);

  if (conflict.exists) {
    if (strategy === 'skip') {
      plan.skipped = true;
      plan.skipReason = `事故ID ${manifest.incidentId} 已存在，按 skip 策略跳过`;
      return plan;
    }

    if (strategy === 'newId') {
      const newIncidentId = uuidv4();
      plan.newIncidentId = newIncidentId;

      plan.incidentData = {
        ...incident,
        id: newIncidentId
      };

      const evidenceIdMap = {};
      plan.evidences = evidences.map(ev => {
        const newEvidenceId = uuidv4();
        evidenceIdMap[ev.id] = newEvidenceId;
        return {
          ...ev,
          id: newEvidenceId,
          incidentId: newIncidentId
        };
      });

      plan.auditLogs = auditLogs.map(log => {
        let newIncidentRef = log.incidentId;
        if (log.incidentId === manifest.incidentId) {
          newIncidentRef = newIncidentId;
        }
        let newLogId = log.id;
        const existingLog = auditLogsStore.findById(log.id);
        if (existingLog) {
          newLogId = `audit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        }
        return {
          ...log,
          id: newLogId,
          incidentId: newIncidentRef,
          sequence: undefined,
          details: log.details && typeof log.details === 'object'
            ? JSON.parse(JSON.stringify(log.details))
            : log.details
        };
      });

      const packageIdMap = {};
      plan.receiptPackages = (receiptPackages || []).map(pkg => {
        const newPkgId = uuidv4();
        packageIdMap[pkg.id] = newPkgId;
        const now = new Date().toISOString();
        const isPending = pkg.status === RECEIPT_PACKAGE_STATUS.PENDING;
        return {
          ...pkg,
          id: newPkgId,
          incidentId: newIncidentId,
          receiptCode: isPending ? '' : (pkg.receiptCode || ''),
          codeHash: isPending ? `imported_disabled_${newPkgId}` : (pkg.codeHash || ''),
          status: isPending ? RECEIPT_PACKAGE_STATUS.REVOKED : pkg.status,
          revokedById: isPending ? 'system' : pkg.revokedById,
          revokedByName: isPending ? '系统导入处理' : pkg.revokedByName,
          revokedAt: isPending ? now : pkg.revokedAt,
          revokeReason: isPending ? (pkg.revokeReason || '导入归档：不恢复待签收包的有效签收码') : pkg.revokeReason,
          supersededById: pkg.supersededById ? (packageIdMap[pkg.supersededById] || pkg.supersededById) : null
        };
      });

      plan.receiptRecords = (receiptRecords || []).map(rec => {
        const newRecId = uuidv4();
        return {
          ...rec,
          id: newRecId,
          receiptPackageId: packageIdMap[rec.receiptPackageId] || rec.receiptPackageId,
          incidentId: newIncidentId
        };
      });

      return plan;
    }
  }

  plan.incidentData = { ...incident };
  plan.evidences = evidences.map(ev => ({ ...ev }));

  const evidenceIdMap = {};
  plan.evidences = evidences.map(ev => {
    const existingEv = evidencesStore.findById(ev.id);
    if (existingEv) {
      const newEvidenceId = uuidv4();
      evidenceIdMap[ev.id] = newEvidenceId;
      return { ...ev, id: newEvidenceId };
    }
    return { ...ev };
  });

  plan.auditLogs = auditLogs.map(log => {
    const existingLog = auditLogsStore.findById(log.id);
    if (existingLog) {
      return {
        ...log,
        id: `audit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        sequence: undefined
      };
    }
    return { ...log, sequence: undefined };
  });

  const pkgIdMap = {};
  plan.receiptPackages = (receiptPackages || []).map(pkg => {
    const existingPkg = receiptPackagesStore.findById(pkg.id);
    let newPkgId = pkg.id;
    if (existingPkg) {
      newPkgId = uuidv4();
    }
    pkgIdMap[pkg.id] = newPkgId;
    const now = new Date().toISOString();
    const isPending = pkg.status === RECEIPT_PACKAGE_STATUS.PENDING;
    return {
      ...pkg,
      id: newPkgId,
      incidentId: plan.newIncidentId || manifest.incidentId,
      receiptCode: isPending ? '' : (pkg.receiptCode || ''),
      codeHash: isPending ? `imported_disabled_${newPkgId}` : (pkg.codeHash || ''),
      status: isPending ? RECEIPT_PACKAGE_STATUS.REVOKED : pkg.status,
      revokedById: isPending ? 'system' : pkg.revokedById,
      revokedByName: isPending ? '系统导入处理' : pkg.revokedByName,
      revokedAt: isPending ? now : pkg.revokedAt,
      revokeReason: isPending ? (pkg.revokeReason || '导入归档：不恢复待签收包的有效签收码') : pkg.revokeReason
    };
  });

  for (const p of plan.receiptPackages) {
    if (p.supersededById && pkgIdMap[p.supersededById]) {
      p.supersededById = pkgIdMap[p.supersededById];
    }
  }

  plan.receiptRecords = (receiptRecords || []).map(rec => {
    const existingRec = receiptRecordsStore.findById(rec.id);
    let newRecId = rec.id;
    if (existingRec) {
      newRecId = uuidv4();
    }
    return {
      ...rec,
      id: newRecId,
      receiptPackageId: pkgIdMap[rec.receiptPackageId] || rec.receiptPackageId,
      incidentId: plan.newIncidentId || manifest.incidentId
    };
  });

  return plan;
}

function executeCommitPlan(plan, user, manifest) {
  const db = getDb();

  const tx = db.transaction(() => {
    if (plan.skipped) return { skipped: true, skipReason: plan.skipReason };

    const incidentData = plan.incidentData;
    const now = new Date().toISOString();

    const existing = incidentsStore.findById(incidentData.id);
    if (existing) {
      throw new Error(`事务内检测到事故ID冲突: ${incidentData.id}`);
    }

    const incidentToInsert = {
      ...incidentData,
      createdAt: incidentData.createdAt || now,
      updatedAt: incidentData.updatedAt || now,
      evidenceCount: plan.evidences.length
    };
    incidentsStore.append(incidentToInsert);

    const existingEvidenceIds = new Set();
    for (const ev of plan.evidences) {
      const dup = evidencesStore.findById(ev.id);
      if (dup) {
        ev.id = uuidv4();
      }
      existingEvidenceIds.add(ev.id);
      evidencesStore.append(ev);
    }

    for (const log of plan.auditLogs) {
      auditLogsStore.append(log);
    }

    for (const pkg of plan.receiptPackages) {
      receiptPackagesStore.append(pkg);
    }

    for (const rec of plan.receiptRecords) {
      receiptRecordsStore.append(rec);
    }

    return {
      imported: true,
      newIncidentId: plan.newIncidentId || plan.oldIncidentId,
      oldIncidentId: plan.oldIncidentId,
      strategy: plan.strategy,
      evidencesImported: plan.evidences.length,
      auditLogsImported: plan.auditLogs.length,
      receiptPackagesImported: plan.receiptPackages.length,
      receiptRecordsImported: plan.receiptRecords.length
    };
  });

  try {
    const result = tx();
    logAction(user.id, user.name, AUDIT_ACTION.DATA_IMPORTED, result.newIncidentId || plan.oldIncidentId, {
      exportId: manifest.exportId,
      exportedAt: manifest.exportedAt,
      sourceIncidentId: plan.oldIncidentId,
      incidentId: result.newIncidentId || plan.oldIncidentId,
      strategy: plan.strategy,
      skipped: !!result.skipped,
      skipReason: result.skipReason || null,
      evidencesCount: plan.evidences.length,
      auditLogsCount: plan.auditLogs.length
    });
    return { success: true, data: result };
  } catch (err) {
    logAction(user.id, user.name, AUDIT_ACTION.DATA_IMPORT_FAILED, plan.oldIncidentId, {
      exportId: manifest.exportId,
      reason: err.message,
      strategy: plan.strategy
    });
    return {
      success: false,
      error: ERROR_CODES.IMPORT_FAILED,
      details: { message: err.message, strategy: plan.strategy }
    };
  }
}

function importIncidentArchive(user, archive, options = {}) {
  const mode = options.mode === 'commit' ? 'commit' : 'dryRun';
  const strategy = CONFLICT_STRATEGIES.includes(options.conflictStrategy)
    ? options.conflictStrategy
    : 'skip';

  const structErrors = validateArchiveStructure(archive);
  if (structErrors.length > 0) {
    logAction(user.id, user.name, AUDIT_ACTION.DATA_IMPORT_VALIDATION_FAILED, null, {
      reason: 'archive_structure_invalid',
      errors: structErrors
    });
    return {
      success: false,
      error: ERROR_CODES.IMPORT_VALIDATION_ERROR,
      details: {
        reason: '归档结构不完整',
        errors: structErrors
      }
    };
  }

  const manifest = archive.manifest;

  const incidentParse = parseJSONSafe(archive.files['incident.json']);
  if (!incidentParse.success) {
    logAction(user.id, user.name, AUDIT_ACTION.DATA_IMPORT_VALIDATION_FAILED, null, {
      reason: 'incident_json_parse_error',
      parseError: incidentParse.error
    });
    return {
      success: false,
      error: ERROR_CODES.IMPORT_VALIDATION_ERROR,
      details: { reason: 'incident.json 解析失败', parseError: incidentParse.error }
    };
  }
  const incident = incidentParse.data;

  const evidencesParse = parseJSONSafe(archive.files['evidences.json']);
  if (!evidencesParse.success) {
    logAction(user.id, user.name, AUDIT_ACTION.DATA_IMPORT_VALIDATION_FAILED, null, {
      reason: 'evidences_json_parse_error',
      parseError: evidencesParse.error
    });
    return {
      success: false,
      error: ERROR_CODES.IMPORT_VALIDATION_ERROR,
      details: { reason: 'evidences.json 解析失败', parseError: evidencesParse.error }
    };
  }
  const evidences = evidencesParse.data;

  const auditLogsParse = parseJSONSafe(archive.files['audit_logs.json']);
  if (!auditLogsParse.success) {
    logAction(user.id, user.name, AUDIT_ACTION.DATA_IMPORT_VALIDATION_FAILED, null, {
      reason: 'audit_logs_json_parse_error',
      parseError: auditLogsParse.error
    });
    return {
      success: false,
      error: ERROR_CODES.IMPORT_VALIDATION_ERROR,
      details: { reason: 'audit_logs.json 解析失败', parseError: auditLogsParse.error }
    };
  }
  const auditLogs = auditLogsParse.data;

  let receiptPackages = [];
  if (archive.files['receipt_packages.json']) {
    const rpParse = parseJSONSafe(archive.files['receipt_packages.json']);
    if (rpParse.success && Array.isArray(rpParse.data)) {
      receiptPackages = rpParse.data;
    }
  }

  let receiptRecords = [];
  if (archive.files['receipt_records.json']) {
    const rrParse = parseJSONSafe(archive.files['receipt_records.json']);
    if (rrParse.success && Array.isArray(rrParse.data)) {
      receiptRecords = rrParse.data;
    }
  }

  const allErrors = [];
  allErrors.push(...validateManifest(manifest, incident, evidences, auditLogs));
  allErrors.push(...validateIncidentData(incident));
  allErrors.push(...validateEvidencesData(evidences));
  allErrors.push(...validateAuditLogsData(auditLogs));

  if (allErrors.length > 0) {
    logAction(user.id, user.name, AUDIT_ACTION.DATA_IMPORT_VALIDATION_FAILED, manifest.incidentId || null, {
      reason: 'content_validation_failed',
      exportId: manifest.exportId,
      errors: allErrors
    });
    return {
      success: false,
      error: ERROR_CODES.IMPORT_VALIDATION_ERROR,
      details: {
        reason: '归档内容校验失败',
        errors: allErrors,
        exportId: manifest.exportId
      }
    };
  }

  const conflict = checkIncidentConflict(manifest.incidentId);
  const plan = buildRemapPlan(manifest, incident, evidences, auditLogs, receiptPackages, receiptRecords, strategy);

  const diff = {
    exportId: manifest.exportId,
    exportedAt: manifest.exportedAt,
    sourceIncident: {
      id: manifest.incidentId,
      title: manifest.incidentTitle || incident.title,
      status: incident.status,
      level: incident.level
    },
    conflict: conflict.exists
      ? { exists: true, strategy, existingId: manifest.incidentId }
      : { exists: false },
    plan: {
      skipped: plan.skipped,
      skipReason: plan.skipReason,
      oldIncidentId: plan.oldIncidentId,
      newIncidentId: plan.newIncidentId,
      incidentWillBeCreated: !plan.skipped,
      evidencesCount: plan.evidences.length,
      auditLogsCount: plan.auditLogs.length,
      receiptPackagesCount: plan.receiptPackages.length,
      receiptRecordsCount: plan.receiptRecords.length,
      evidenceIds: plan.evidences.map(ev => ({ old: ev.id, new: ev.id })),
      remapped: plan.newIncidentId !== null
    },
    counts: {
      incidents: 1,
      evidences: plan.evidences.length,
      auditLogs: plan.auditLogs.length,
      receiptPackages: plan.receiptPackages.length,
      receiptRecords: plan.receiptRecords.length
    }
  };

  if (mode === 'dryRun') {
    logAction(user.id, user.name, AUDIT_ACTION.DATA_IMPORTED, manifest.incidentId, {
      exportId: manifest.exportId,
      mode: 'dryRun',
      strategy,
      skipped: plan.skipped,
      diff: {
        conflict: diff.conflict,
        newIncidentId: plan.newIncidentId,
        evidencesCount: plan.evidences.length,
        auditLogsCount: plan.auditLogs.length
      }
    });
    return {
      success: true,
      data: {
        mode: 'dryRun',
        valid: true,
        diff,
        readyForCommit: !plan.skipped,
        strategy
      }
    };
  }

  return executeCommitPlan(plan, user, manifest);
}

function importIncidentArchiveFromFile(user, filename, options = {}) {
  const accessCheck = validateArchiveFileAccess(user, filename);
  if (!accessCheck.success) {
    const auditAction = (accessCheck.auditReason === 'file_json_parse_error' || accessCheck.auditReason === 'path_not_a_file')
      ? AUDIT_ACTION.DATA_IMPORT_VALIDATION_FAILED
      : AUDIT_ACTION.DATA_IMPORT_FAILED;
    logAction(user.id, user.name, auditAction, null, {
      reason: accessCheck.auditReason,
      ...accessCheck.auditDetails
    });
    return {
      success: false,
      error: accessCheck.error,
      details: accessCheck.details
    };
  }

  const filePath = accessCheck.filePath;
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    logAction(user.id, user.name, AUDIT_ACTION.DATA_IMPORT_FAILED, null, {
      reason: 'file_read_error',
      filePath,
      message: err.message
    });
    return {
      success: false,
      error: ERROR_CODES.IMPORT_FAILED,
      details: { reason: '读取归档文件失败', message: err.message, filePath }
    };
  }

  const parsed = parseJSONSafe(raw);
  if (!parsed.success) {
    logAction(user.id, user.name, AUDIT_ACTION.DATA_IMPORT_VALIDATION_FAILED, null, {
      reason: 'file_json_parse_error',
      filePath,
      parseError: parsed.error
    });
    return {
      success: false,
      error: ERROR_CODES.IMPORT_VALIDATION_ERROR,
      details: {
        reason: '归档文件不是有效的 JSON',
        parseError: parsed.error,
        filePath,
        hint: '请确认该文件为完整的事故归档包（含 manifest 与 files 字段）'
      }
    };
  }

  const result = importIncidentArchive(user, parsed.data, options);
  if (result.success) {
    result.data.sourceFile = {
      filePath,
      filename: path.basename(filePath),
      exportDir: accessCheck.exportDir
    };
  }
  return result;
}

function listImportableArchives(user) {
  const config = getExportConfig();
  const exportDir = path.resolve(config.exportDir);
  const result = [];

  if (!fs.existsSync(exportDir)) {
    return { success: true, data: [], exportDir };
  }

  let entries;
  try {
    entries = fs.readdirSync(exportDir, { withFileTypes: true });
  } catch (err) {
    return {
      success: false,
      error: ERROR_CODES.IMPORT_FAILED,
      details: { reason: '读取导出目录失败', message: err.message, exportDir }
    };
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const fullPath = path.join(exportDir, entry.name);
    try {
      const stat = fs.statSync(fullPath);
      const raw = fs.readFileSync(fullPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed.manifest && parsed.files) {
        result.push({
          filename: entry.name,
          filePath: fullPath,
          size: stat.size,
          mtime: stat.mtime.toISOString(),
          exportDir,
          manifest: {
            exportId: parsed.manifest.exportId,
            exportedAt: parsed.manifest.exportedAt,
            incidentId: parsed.manifest.incidentId,
            incidentTitle: parsed.manifest.incidentTitle,
            dataFormat: parsed.manifest.dataFormat,
            counts: parsed.manifest.counts
          }
        });
      }
    } catch (err) {
    }
  }

  return {
    success: true,
    data: result.sort((a, b) => new Date(b.mtime) - new Date(a.mtime)),
    exportDir
  };
}

module.exports = {
  importIncidentArchive,
  importIncidentArchiveFromFile,
  listImportableArchives,
  validateArchiveStructure,
  validateManifest,
  validateArchiveFileAccess,
  isPathWithinDir,
  CONFLICT_STRATEGIES
};
