const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { INCIDENT_STATUS, INCIDENT_LEVEL, USER_ROLE } = require('../src/constants/status');

const DATA_DIR = path.join(__dirname, '..', 'data');

function readJson(filePath) {
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }
  return [];
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function seedData() {
  console.log('生成示例数据...');

  const usersFile = path.join(DATA_DIR, 'users.json');
  let users = readJson(usersFile);
  if (users.length === 0) {
    users = [
      { id: 'reporter-001', name: '张三', role: USER_ROLE.REPORTER, createdAt: new Date().toISOString() },
      { id: 'foreman-001', name: '王班长', role: USER_ROLE.FOREMAN, createdAt: new Date().toISOString() },
      { id: 'security-001', name: '赵安保', role: USER_ROLE.SECURITY, createdAt: new Date().toISOString() },
      { id: 'admin-001', name: '孙管理', role: USER_ROLE.ADMIN, createdAt: new Date().toISOString() }
    ];
    writeJson(usersFile, users);
    console.log('✓ 已创建用户数据');
  }

  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 3600000);
  const twoHoursAgo = new Date(now.getTime() - 7200000);
  const threeHoursAgo = new Date(now.getTime() - 10800000);

  const incidentsFile = path.join(DATA_DIR, 'incidents.json');
  let incidents = readJson(incidentsFile);

  if (incidents.length === 0) {
    incidents = [
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
        createdAt: threeHoursAgo.toISOString(),
        updatedAt: twoHoursAgo.toISOString(),
        evidenceCount: 2
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
        createdAt: twoHoursAgo.toISOString(),
        updatedAt: oneHourAgo.toISOString(),
        evidenceCount: 1
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
        createdAt: oneHourAgo.toISOString(),
        updatedAt: oneHourAgo.toISOString(),
        evidenceCount: 0
      }
    ];
    writeJson(incidentsFile, incidents);
    console.log('✓ 已创建示例事故数据');
  }

  const evidencesFile = path.join(DATA_DIR, 'evidences.json');
  let evidences = readJson(evidencesFile);

  if (evidences.length === 0 && incidents.length > 0) {
    const incident1 = incidents[0];
    const incident2 = incidents[1];

    evidences = [
      {
        id: uuidv4(),
        incidentId: incident1.id,
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
        incidentId: incident1.id,
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
        incidentId: incident2.id,
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
    writeJson(evidencesFile, evidences);
    console.log('✓ 已创建示例证据数据');
  }

  const auditLogsFile = path.join(DATA_DIR, 'audit_logs.json');
  if (!fs.existsSync(auditLogsFile) || readJson(auditLogsFile).length === 0) {
    writeJson(auditLogsFile, []);
    console.log('✓ 已初始化审计日志');
  }

  console.log('');
  console.log('示例数据生成完成！');
}

seedData();
