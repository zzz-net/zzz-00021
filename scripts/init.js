const { getDb } = require('../src/storage/sqliteStore');
const { USER_ROLE } = require('../src/constants/status');

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

function initData() {
  console.log('初始化数据 (SQLite)...');
  const db = getDb();

  const existingCount = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
  if (existingCount === 0) {
    const insertStmt = db.prepare(
      'INSERT INTO users (id, name, role, createdAt) VALUES (@id, @name, @role, @createdAt)'
    );
    const tx = db.transaction((users) => {
      for (const u of users) insertStmt.run(u);
    });
    tx(defaultUsers);
    console.log('✓ 用户数据已创建');
  } else {
    console.log('- 用户数据已存在，跳过');
  }

  console.log('');
  console.log('初始化完成！数据库文件: data/duty-incidents.db');
  console.log('可用用户列表：');
  const users = db.prepare('SELECT id, name, role FROM users ORDER BY id').all();
  users.forEach(u => {
    console.log(`  ${u.id} - ${u.name} (${u.role})`);
  });
  console.log('');
  console.log('使用方法：请求时添加 Header: X-User-Id: <用户ID>');
}

initData();
