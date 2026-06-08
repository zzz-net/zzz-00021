const { getDb, DATA_DIR } = require('../storage/sqliteStore');
const { logAction, AUDIT_ACTION } = require('./auditService');
const path = require('path');
const fs = require('fs');

const DEFAULT_CONFIG = {
  exportDir: path.join(DATA_DIR, 'exports'),
  filenamePrefix: 'duty-export',
  conflictStrategy: 'suffix'
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
    logAction(user.id, user.name, AUDIT_ACTION.EXPORT_CONFIG_UPDATED, null, changes);
  }

  return getExportConfig();
}

module.exports = {
  getExportConfig,
  updateExportConfig,
  getAllDbConfig,
  DEFAULT_CONFIG
};
