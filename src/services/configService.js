const { getDb, DATA_DIR } = require('../storage/sqliteStore');
const { AUDIT_ACTION, INCIDENT_LEVEL } = require('../constants/status');
const path = require('path');
const fs = require('fs');

const DEFAULT_CONFIG = {
  exportDir: path.join(DATA_DIR, 'exports'),
  filenamePrefix: 'duty-export',
  conflictStrategy: 'suffix'
};

const DEFAULT_OVERDUE_CONFIG = {
  [INCIDENT_LEVEL.LOW]: 72,
  [INCIDENT_LEVEL.MEDIUM]: 48,
  [INCIDENT_LEVEL.HIGH]: 24,
  [INCIDENT_LEVEL.CRITICAL]: 12
};

function getDbConfig(key) {
  const db = getDb();
  const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setDbConfig(key, value) {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO app_config (key, value, updatedAt)
    VALUES (@key, @value, @updatedAt)
    ON CONFLICT(key) DO UPDATE SET value = @value, updatedAt = @updatedAt
  `).run({ key, value, updatedAt: now });
}

function getAllDbConfig() {
  const db = getDb();
  const rows = db.prepare('SELECT key, value, updatedAt FROM app_config').all();
  const result = {};
  for (const row of rows) {
    result[row.key] = { value: row.value, updatedAt: row.updatedAt };
  }
  return result;
}

function getExportConfig() {
  const exportDir = getDbConfig('export_dir') || DEFAULT_CONFIG.exportDir;
  const filenamePrefix = getDbConfig('filename_prefix') || DEFAULT_CONFIG.filenamePrefix;
  const conflictStrategy = getDbConfig('conflict_strategy') || DEFAULT_CONFIG.conflictStrategy;

  if (!fs.existsSync(exportDir)) {
    fs.mkdirSync(exportDir, { recursive: true });
  }

  return {
    exportDir,
    filenamePrefix,
    conflictStrategy
  };
}

function updateExportConfig(user, updates = {}) {
  const allowed = ['exportDir', 'filenamePrefix', 'conflictStrategy'];
  const dbKeyMap = {
    exportDir: 'export_dir',
    filenamePrefix: 'filename_prefix',
    conflictStrategy: 'conflict_strategy'
  };

  const changes = {};
  for (const key of allowed) {
    if (updates[key] !== undefined && updates[key] !== null) {
      if (key === 'conflictStrategy' && !['suffix', 'error'].includes(updates[key])) {
        throw new Error('conflictStrategy 必须是 suffix 或 error');
      }
      if (key === 'filenamePrefix' && (typeof updates[key] !== 'string' || updates[key].length === 0)) {
        throw new Error('filenamePrefix 必须是非空字符串');
      }
      if (key === 'exportDir') {
        const dir = path.resolve(updates[key]);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        setDbConfig(dbKeyMap[key], dir);
        changes[key] = dir;
      } else {
        setDbConfig(dbKeyMap[key], String(updates[key]));
        changes[key] = String(updates[key]);
      }
    }
  }

  if (Object.keys(changes).length > 0) {
    const { logAction } = require('./auditService');
    logAction(user.id, user.name, AUDIT_ACTION.EXPORT_CONFIG_UPDATED, null, changes);
  }

  return getExportConfig();
}

function getOverdueConfig() {
  const dbValue = getDbConfig('overdue_config');
  if (dbValue) {
    try {
      const parsed = JSON.parse(dbValue);
      return { ...DEFAULT_OVERDUE_CONFIG, ...parsed };
    } catch (e) {
      console.error('Failed to parse overdue_config from DB:', e);
    }
  }
  return { ...DEFAULT_OVERDUE_CONFIG };
}

function updateOverdueConfig(user, updates = {}) {
  const validLevels = Object.values(INCIDENT_LEVEL);
  const changes = {};
  const currentConfig = getOverdueConfig();

  for (const level of validLevels) {
    if (updates[level] !== undefined && updates[level] !== null) {
      const hours = Number(updates[level]);
      if (isNaN(hours) || hours < 0 || !isFinite(hours)) {
        throw new Error(`${level} 的超时小时数必须是非负数字`);
      }
      changes[level] = hours;
    }
  }

  if (Object.keys(changes).length === 0) {
    return currentConfig;
  }

  const newConfig = { ...currentConfig, ...changes };
  setDbConfig('overdue_config', JSON.stringify(newConfig));

  const { logAction } = require('./auditService');
  logAction(user.id, user.name, AUDIT_ACTION.OVERDUE_CONFIG_UPDATED, null, {
    before: currentConfig,
    after: newConfig,
    changes
  });

  return newConfig;
}

module.exports = {
  getExportConfig,
  updateExportConfig,
  getAllDbConfig,
  DEFAULT_CONFIG,
  getOverdueConfig,
  updateOverdueConfig,
  DEFAULT_OVERDUE_CONFIG
};
