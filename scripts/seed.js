const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../src/storage/sqliteStore');
const { INCIDENT_STATUS, INCIDENT_LEVEL, USER_ROLE } = require('../src/constants/status');

function seedData() {
  console.log('生成示例数据 (SQLite)...');
  const db = getDb();

  const userCount = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
  if (userCount === 0) {
    const users = [
      { id: 'reporter-001', name: '张三', role: USER_ROLE.REPORTER, createdAt: new Date().toISOString() },
      { id: 'reporter-002', name: '李四', role: USER_ROLE.REPORTER, createdAt: new Date().toISOString() },
      { id: 'foreman-001', name: '王班长', role: USER_ROLE.FOREMAN, createdAt: new Date().toISOString() },
      { id: 'security-001', name: '赵安保', role: USER_ROLE.SECURITY, createdAt: new Date().toISOString() },
      { id: 'admin-001', name: '孙管理', role: USER_ROLE.ADMIN, createdAt: new Date().toISOString() }
    ];
    const insertUser = db.prepare(
      'INSERT INTO users (id, name, role, createdAt) VALUES (@id, @name, @role, @createdAt)'
    );
    const tx = db.transaction(us => { for (const u of us) insertUser.run(u); });
    tx(users);
    console.log('✓ 已创建用户数据');
  }

  const incidentCount = db.prepare('SELECT COUNT(*) as cnt FROM incidents').get().cnt;
  if (incidentCount === 0) {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 3600000);
    const twoHoursAgo = new Date(now.getTime() - 7200000);
    const threeHoursAgo = new Date(now.getTime() - 10800000);

    const incidents = [
      {
        id: uuidv4(),
        title: 'A区配电室跳闸事故',
        description: 'A区配电室发生跳闸，导致部分区域断电',
        location: 'A区配电室',
        level: INCIDENT_LEVEL.HIGH,
        occurredAt: threeHoursAgo.toISOString(),
        status: INCIDENT_STATUS.EVIDENCE_COLLECTING,
        reporterId: 'reporter-001',
        reporterName: '张三',
        currentHandlerId: 'reporter-001',
        currentHandlerName: '张三',
        returnReason: null,
        evidenceCount: 2,
        createdAt: threeHoursAgo.toISOString(),
        updatedAt: twoHoursAgo.toISOString()
      },
      {
        id: uuidv4(),
        title: 'B区消防通道堵塞',
        description: 'B区消防通道被杂物堵塞，存在安全隐患',
        location: 'B区一楼消防通道',
        level: INCIDENT_LEVEL.MEDIUM,
        occurredAt: twoHoursAgo.toISOString(),
        status: INCIDENT_STATUS.FOREMAN_REVIEWED,
        reporterId: 'reporter-001',
        reporterName: '张三',
        currentHandlerId: 'foreman-001',
        currentHandlerName: '王班长',
        returnReason: null,
        evidenceCount: 1,
        createdAt: twoHoursAgo.toISOString(),
        updatedAt: oneHourAgo.toISOString()
      },
      {
        id: uuidv4(),
        title: 'C区设备异常报警',
        description: 'C区3号设备出现温度异常报警，已通知维修人员',
        location: 'C区生产车间',
        level: INCIDENT_LEVEL.LOW,
        occurredAt: oneHourAgo.toISOString(),
        status: INCIDENT_STATUS.REPORTED,
        reporterId: 'reporter-002',
        reporterName: '李四',
        currentHandlerId: 'reporter-002',
        currentHandlerName: '李四',
        returnReason: null,
        evidenceCount: 0,
        createdAt: oneHourAgo.toISOString(),
        updatedAt: oneHourAgo.toISOString()
      }
    ];

    const insertIncident = db.prepare(`
      INSERT INTO incidents 
      (id, title, description, location, level, occurredAt, status, reporterId, reporterName, 
       currentHandlerId, currentHandlerName, returnReason, evidenceCount, createdAt, updatedAt)
      VALUES (@id, @title, @description, @location, @level, @occurredAt, @status, @reporterId, @reporterName,
              @currentHandlerId, @currentHandlerName, @returnReason, @evidenceCount, @createdAt, @updatedAt)
    `);
    const tx2 = db.transaction(items => { for (const i of items) insertIncident.run(i); });
    tx2(incidents);
    console.log('✓ 已创建示例事故数据');

    const evidenceCount = db.prepare('SELECT COUNT(*) as cnt FROM evidences').get().cnt;
    if (evidenceCount === 0) {
      const evidences = [
        {
          id: uuidv4(),
          incidentId: incidents[0].id,
          type: 'photo',
          description: '配电室跳闸现场照片',
          collectedAt: twoHoursAgo.toISOString(),
          collectorId: 'reporter-001',
          collectorName: '张三',
          filePath: '/data/photos/a-district-trip-001.jpg',
          fileHash: 'sha256:a1b2c3d4e5f678901234567890abcdef1234567890abcdef1234567890abcdef',
          createdAt: twoHoursAgo.toISOString()
        },
        {
          id: uuidv4(),
          incidentId: incidents[0].id,
          type: 'document',
          description: '设备运维记录',
          collectedAt: new Date(twoHoursAgo.getTime() + 1800000).toISOString(),
          collectorId: 'reporter-001',
          collectorName: '张三',
          filePath: '/data/docs/maintenance-log-2024-001.pdf',
          fileHash: 'sha256:fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321',
          createdAt: new Date(twoHoursAgo.getTime() + 1800000).toISOString()
        },
        {
          id: uuidv4(),
          incidentId: incidents[1].id,
          type: 'photo',
          description: '消防通道堵塞照片',
          collectedAt: new Date(oneHourAgo.getTime() + 1800000).toISOString(),
          collectorId: 'foreman-001',
          collectorName: '王班长',
          filePath: '/data/photos/b-fire-exit-001.jpg',
          fileHash: 'sha256:11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff',
          createdAt: new Date(oneHourAgo.getTime() + 1800000).toISOString()
        }
      ];
      const insertEvidence = db.prepare(`
        INSERT INTO evidences
        (id, incidentId, type, description, collectedAt, collectorId, collectorName, filePath, fileHash, createdAt)
        VALUES (@id, @incidentId, @type, @description, @collectedAt, @collectorId, @collectorName, @filePath, @fileHash, @createdAt)
      `);
      const tx3 = db.transaction(items => { for (const e of items) insertEvidence.run(e); });
      tx3(evidences);
      console.log('✓ 已创建示例证据数据');
    }
  }

  console.log('');
  console.log('示例数据生成完成！数据库文件: data/duty-incidents.db');
}

seedData();
