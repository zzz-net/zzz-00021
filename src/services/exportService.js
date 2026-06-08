const { incidentsStore, evidencesStore } = require('../storage');
const { getAuditLogs } = require('./auditService');
const { logAction, AUDIT_ACTION } = require('./auditService');

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

function exportIncidents(user, format = 'json') {
  const incidents = incidentsStore.readAll();
  
  logAction(user.id, user.name, AUDIT_ACTION.DATA_EXPORTED, null, {
    type: 'incidents',
    format,
    count: incidents.length
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
      { key: 'createdAt', label: '创建时间' },
      { key: 'updatedAt', label: '更新时间' }
    ];
    return { format, content: toCSV(incidents, columns), filename: 'incidents.csv' };
  }

  return { format: 'json', content: JSON.stringify(incidents, null, 2), filename: 'incidents.json' };
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
    count: logs.length
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

module.exports = {
  exportIncidents,
  exportEvidences,
  exportAuditLogs
};
