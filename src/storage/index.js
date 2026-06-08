const { SqliteStore, AuditLogSqliteStore } = require('./sqliteStore');

const incidentsStore = new SqliteStore('incidents');
const evidencesStore = new SqliteStore('evidences');
const usersStore = new SqliteStore('users');
const auditLogsStore = new AuditLogSqliteStore();
const receiptPackagesStore = new SqliteStore('receipt_packages');
const receiptRecordsStore = new SqliteStore('receipt_records');
const shiftHandoversStore = new SqliteStore('shift_handovers');

module.exports = {
  incidentsStore,
  evidencesStore,
  usersStore,
  auditLogsStore,
  receiptPackagesStore,
  receiptRecordsStore,
  shiftHandoversStore
};
