const { JsonStore, AuditLogStore } = require('./jsonStore');

const incidentsStore = new JsonStore('incidents');
const evidencesStore = new JsonStore('evidences');
const usersStore = new JsonStore('users');
const auditLogsStore = new AuditLogStore();

module.exports = {
  incidentsStore,
  evidencesStore,
  usersStore,
  auditLogsStore
};
