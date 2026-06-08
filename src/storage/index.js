const { SqliteStore, AuditLogSqliteStore } = require('./sqliteStore');

const incidentsStore = new SqliteStore('incidents');
const evidencesStore = new SqliteStore('evidences');
const usersStore = new SqliteStore('users');
const auditLogsStore = new AuditLogSqliteStore();

module.exports = {
  incidentsStore,
  evidencesStore,
  usersStore,
  auditLogsStore
};
