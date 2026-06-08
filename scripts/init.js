const fs = require('fs');
const path = require('path');
const { USER_ROLE } = require('../src/constants/status');

const DATA_DIR = path.join(__dirname, '..', 'data');

const defaultUsers = [
  {
    id: 'reporter-001',
    name: '张三',
    role: USER_ROLE.REPORTER,
    createdAt: new Date().toISOString()
  },
  {
    id: 'reporter-002',
    name: '李四',
    role: USER_ROLE.REPORTER,
    createdAt: new Date().toISOString()
  },
  {
    id: 'foreman-001',
    name: '王班长',
    role: USER_ROLE.FOREMAN,
    createdAt: new Date().toISOString()
  },
  {
    id: 'security-001',
    name: '赵安保',
    role: USER_ROLE.SECURITY,
    createdAt: new Date().toISOString()
  },
  {
    id: 'admin-001',
    name: '孙管理',
    role: USER_ROLE.ADMIN,
    createdAt: new Date().toISOString()
  }
];

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function writeJsonFile(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function initData() {
  console.log('初始化数据...');
  ensureDir(DATA_DIR);

  const usersFile = path.join(DATA_DIR, 'users.json');
  if (!fs.existsSync(usersFile)) {
    writeJsonFile(usersFile, defaultUsers);
    console.log('✓ 用户数据已创建');
  } else {
    console.log('- 用户数据已存在，跳过');
  }

  const incidentsFile = path.join(DATA_DIR, 'incidents.json');
  if (!fs.existsSync(incidentsFile)) {
    writeJsonFile(incidentsFile, []);
    console.log('✓ 事故数据已初始化');
  }

  const evidencesFile = path.join(DATA_DIR, 'evidences.json');
  if (!fs.existsSync(evidencesFile)) {
    writeJsonFile(evidencesFile, []);
    console.log('✓ 证据数据已初始化');
  }

  const auditLogsFile = path.join(DATA_DIR, 'audit_logs.json');
  if (!fs.existsSync(auditLogsFile)) {
    writeJsonFile(auditLogsFile, []);
    console.log('✓ 审计日志已初始化');
  }

  console.log('');
  console.log('初始化完成！可用用户列表：');
  defaultUsers.forEach(u => {
    console.log(`  ${u.id} - ${u.name} (${u.role})`);
  });
  console.log('');
  console.log('使用方法：请求时添加 Header: X-User-Id: <用户ID>');
}

initData();
