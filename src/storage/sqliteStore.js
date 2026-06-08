const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'duty-incidents.db');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

let sharedDb = null;
function getDb() {
  if (!sharedDb) {
    ensureDataDir();
    sharedDb = new Database(DB_FILE);
    sharedDb.pragma('journal_mode = WAL');
    sharedDb.pragma('foreign_keys = ON');
    initTables(sharedDb);
  }
  return sharedDb;
}

function initTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS incidents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      location TEXT NOT NULL,
      level TEXT NOT NULL,
      occurredAt TEXT NOT NULL,
      status TEXT NOT NULL,
      reporterId TEXT NOT NULL,
      reporterName TEXT NOT NULL,
      currentHandlerId TEXT NOT NULL,
      currentHandlerName TEXT NOT NULL,
      returnReason TEXT,
      evidenceCount INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_incidents_location ON incidents(location);
    CREATE INDEX IF NOT EXISTS idx_incidents_level ON incidents(level);
    CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);

    CREATE TABLE IF NOT EXISTS evidences (
      id TEXT PRIMARY KEY,
      incidentId TEXT NOT NULL,
      sequence INTEGER NOT NULL DEFAULT 0,
      type TEXT,
      description TEXT,
      collectedAt TEXT NOT NULL,
      collectorId TEXT NOT NULL,
      collectorName TEXT NOT NULL,
      filePath TEXT,
      fileHash TEXT,
      createdAt TEXT NOT NULL,
      FOREIGN KEY (incidentId) REFERENCES incidents(id)
    );

    CREATE INDEX IF NOT EXISTS idx_evidences_incidentId ON evidences(incidentId);
    CREATE INDEX IF NOT EXISTS idx_evidences_fileHash ON evidences(fileHash);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      sequence INTEGER UNIQUE,
      userId TEXT NOT NULL,
      userName TEXT NOT NULL,
      action TEXT NOT NULL,
      incidentId TEXT,
      previousStatus TEXT,
      currentStatus TEXT,
      details TEXT,
      timestamp TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_incidentId ON audit_logs(incidentId);
    CREATE INDEX IF NOT EXISTS idx_audit_userId ON audit_logs(userId);
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);

    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS receipt_packages (
      id TEXT PRIMARY KEY,
      incidentId TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      receiptCode TEXT NOT NULL,
      codeHash TEXT NOT NULL,
      deadline TEXT NOT NULL,
      creatorId TEXT NOT NULL,
      creatorName TEXT NOT NULL,
      incidentSnapshot TEXT NOT NULL,
      evidenceSummary TEXT NOT NULL,
      auditSummary TEXT NOT NULL,
      exportFingerprint TEXT NOT NULL,
      receiverName TEXT,
      signerId TEXT,
      signerName TEXT,
      signedAt TEXT,
      revokedById TEXT,
      revokedByName TEXT,
      revokedAt TEXT,
      revokeReason TEXT,
      supersededById TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_receipt_incidentId ON receipt_packages(incidentId);
    CREATE INDEX IF NOT EXISTS idx_receipt_status ON receipt_packages(status);
    CREATE INDEX IF NOT EXISTS idx_receipt_codeHash ON receipt_packages(codeHash);
    CREATE INDEX IF NOT EXISTS idx_receipt_deadline ON receipt_packages(deadline);

    CREATE TABLE IF NOT EXISTS receipt_records (
      id TEXT PRIMARY KEY,
      receiptPackageId TEXT NOT NULL,
      incidentId TEXT NOT NULL,
      action TEXT NOT NULL,
      operatorId TEXT NOT NULL,
      operatorName TEXT NOT NULL,
      details TEXT,
      timestamp TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_receipt_records_packageId ON receipt_records(receiptPackageId);
    CREATE INDEX IF NOT EXISTS idx_receipt_records_incidentId ON receipt_records(incidentId);
    CREATE INDEX IF NOT EXISTS idx_receipt_records_action ON receipt_records(action);
  `);
}

class SqliteStore {
  constructor(entityName) {
    this.entityName = entityName;
    this.db = getDb();
  }

  rowToObj(row) {
    if (!row) return row;
    const obj = {};
    const jsonFields = ['details', 'incidentSnapshot', 'evidenceSummary', 'auditSummary', 'exportFingerprint'];
    for (const key of Object.keys(row)) {
      if (jsonFields.includes(key) && row[key] !== null && row[key] !== undefined) {
        try { obj[key] = JSON.parse(row[key]); } catch { obj[key] = row[key]; }
      } else {
        obj[key] = row[key];
      }
    }
    return obj;
  }

  readAll() {
    const rows = this.db.prepare(`SELECT * FROM ${this.entityName}`).all();
    return rows.map(r => this.rowToObj(r));
  }

  writeAll(data) {
    const tx = this.db.transaction((items) => {
      this.db.prepare(`DELETE FROM ${this.entityName}`).run();
      if (items.length === 0) return;
      const columns = Object.keys(items[0]);
      const placeholders = columns.map(c => `@${c}`).join(', ');
      const stmt = this.db.prepare(`INSERT INTO ${this.entityName} (${columns.join(', ')}) VALUES (${placeholders})`);
      const jsonFields = ['details', 'incidentSnapshot', 'evidenceSummary', 'auditSummary', 'exportFingerprint'];
      for (const item of items) {
        const toInsert = {};
        for (const col of columns) {
          if (jsonFields.includes(col) && item[col] && typeof item[col] === 'object') {
            toInsert[col] = JSON.stringify(item[col]);
          } else {
            toInsert[col] = item[col];
          }
        }
        stmt.run(toInsert);
      }
    });
    try {
      tx(data);
      return true;
    } catch (err) {
      console.error(`Error writing ${this.entityName}:`, err);
      return false;
    }
  }

  append(record) {
    const columns = Object.keys(record);
    const placeholders = columns.map(c => `@${c}`).join(', ');
    const jsonFields = ['details', 'incidentSnapshot', 'evidenceSummary', 'auditSummary', 'exportFingerprint'];
    const toInsert = {};
    for (const col of columns) {
      if (jsonFields.includes(col) && record[col] && typeof record[col] === 'object') {
        toInsert[col] = JSON.stringify(record[col]);
      } else {
        toInsert[col] = record[col];
      }
    }
    try {
      this.db.prepare(`INSERT INTO ${this.entityName} (${columns.join(', ')}) VALUES (${placeholders})`).run(toInsert);
      return true;
    } catch (err) {
      console.error(`Error appending to ${this.entityName}:`, err);
      return false;
    }
  }

  findById(id) {
    const row = this.db.prepare(`SELECT * FROM ${this.entityName} WHERE id = ?`).get(id);
    return this.rowToObj(row);
  }

  findOne(predicate) {
    const all = this.readAll();
    return all.find(predicate);
  }

  findMany(predicate) {
    const all = this.readAll();
    if (!predicate) return all;
    return all.filter(predicate);
  }

  updateById(id, updater) {
    const existing = this.findById(id);
    if (!existing) return null;
    const updated = updater(existing);
    const columns = Object.keys(updated).filter(c => c !== 'id');
    const setClause = columns.map(c => `${c} = @${c}`).join(', ');
    const jsonFields = ['details', 'incidentSnapshot', 'evidenceSummary', 'auditSummary', 'exportFingerprint'];
    const toUpdate = { id };
    for (const col of columns) {
      if (jsonFields.includes(col) && updated[col] && typeof updated[col] === 'object') {
        toUpdate[col] = JSON.stringify(updated[col]);
      } else {
        toUpdate[col] = updated[col];
      }
    }
    this.db.prepare(`UPDATE ${this.entityName} SET ${setClause} WHERE id = @id`).run(toUpdate);
    return this.rowToObj(this.db.prepare(`SELECT * FROM ${this.entityName} WHERE id = ?`).get(id));
  }

  replaceById(id, newRecord) {
    const existing = this.findById(id);
    if (!existing) return null;
    const merged = { ...existing, ...newRecord, id };
    const columns = Object.keys(merged).filter(c => c !== 'id');
    const setClause = columns.map(c => `${c} = @${c}`).join(', ');
    const jsonFields = ['details', 'incidentSnapshot', 'evidenceSummary', 'auditSummary', 'exportFingerprint'];
    const toUpdate = { id };
    for (const col of columns) {
      if (jsonFields.includes(col) && merged[col] && typeof merged[col] === 'object') {
        toUpdate[col] = JSON.stringify(merged[col]);
      } else {
        toUpdate[col] = merged[col];
      }
    }
    this.db.prepare(`UPDATE ${this.entityName} SET ${setClause} WHERE id = @id`).run(toUpdate);
    return this.rowToObj(this.db.prepare(`SELECT * FROM ${this.entityName} WHERE id = ?`).get(id));
  }
}

class AuditLogSqliteStore extends SqliteStore {
  constructor() {
    super('audit_logs');
  }

  append(record) {
    const row = this.db.prepare('SELECT MAX(sequence) as maxSeq FROM audit_logs').get();
    const nextSeq = (row && row.maxSeq) ? row.maxSeq + 1 : 1;
    const detailsObj = record.details && typeof record.details === 'object' ? record.details : {};
    const fullRecord = {
      ...record,
      sequence: nextSeq,
      previousStatus: record.previousStatus != null ? record.previousStatus : (detailsObj.from || null),
      currentStatus: record.currentStatus != null ? record.currentStatus : (detailsObj.to || null),
      timestamp: record.timestamp || new Date().toISOString()
    };
    return super.append(fullRecord);
  }
}

module.exports = {
  SqliteStore,
  AuditLogSqliteStore,
  DATA_DIR,
  DB_FILE,
  getDb
};
