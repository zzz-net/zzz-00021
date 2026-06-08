const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');

const BASE_URL = 'http://localhost:3000/api';
const ADMIN = 'admin-001';
const SECURITY = 'security-001';
const REPORTER = 'reporter-001';
const SERVER_ENTRY = path.join(__dirname, '..', 'src', 'server.js');

let passCount = 0;
let failCount = 0;
const failures = [];

let serverProc = null;
let serverStdoutBuf = '';
let serverStderrBuf = '';

function request(method, path, { userId, body, query } = {}) {
  return new Promise((resolve) => {
    let urlPath = path;
    if (query) {
      const qs = Object.entries(query)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
      if (qs) urlPath += '?' + qs;
    }
    const url = new URL(BASE_URL + urlPath);
    const headers = { 'Content-Type': 'application/json' };
    if (userId) headers['X-User-Id'] = userId;
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = data;
        try { parsed = data ? JSON.parse(data) : null; } catch {}
        resolve({ status: res.statusCode, body: parsed, raw: data });
      });
    });
    req.on('error', (err) => resolve({ status: 0, body: null, error: err.message }));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function assert(label, condition, detail) {
  if (condition) {
    passCount++;
    console.log(`  ✓ ${label}`);
  } else {
    failCount++;
    const msg = detail ? `${label} — ${detail}` : label;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

function assertHasKey(label, obj, key) {
  assert(label, obj && typeof obj === 'object' && key in obj,
    `期望对象含 ${key}，实际 ${obj ? Object.keys(obj).join(',') : 'null'}`);
}

function waitPort(port, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.end(); resolve(true); });
      sock.once('error', () => {
        if (Date.now() - start > timeoutMs) resolve(false);
        else setTimeout(check, 200);
      });
    };
    check();
  });
}

function startServer(clearDb = true) {
  return new Promise(async (resolve) => {
    if (clearDb) {
      const dbPath = path.join(__dirname, '..', 'data', 'incidents.db');
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    }
    serverProc = spawn('node', [SERVER_ENTRY], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, PORT: '3000' }
    });
    serverProc.stdout.on('data', (d) => { serverStdoutBuf += d.toString(); });
    serverProc.stderr.on('data', (d) => { serverStderrBuf += d.toString(); });
    serverProc.on('exit', (code) => {
      console.log(`[server] 退出码 ${code}`);
    });
    const ok = await waitPort(3000, 20000);
    if (!ok) {
      console.log('[server] stdout:', serverStdoutBuf);
      console.log('[server] stderr:', serverStderrBuf);
    }
    resolve(ok);
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!serverProc) return resolve();
    serverProc.once('exit', () => resolve());
    serverProc.kill('SIGTERM');
    setTimeout(() => { if (serverProc && !serverProc.killed) { serverProc.kill('SIGKILL'); resolve(); } }, 5000);
  });
}

async function createClosedIncident(seed) {
  const resp = await request('POST', '/incidents', {
    userId: SECURITY,
    body: {
      title: `签收测试事故-${seed}`,
      level: 'medium',
      description: `测试描述-${seed}`,
      location: '测试地点'
    }
  });
  const incidentId = resp.body.data.id;
  await request('POST', `/incidents/${incidentId}/start-evidence`, { userId: SECURITY });
  await request('POST', `/incidents/${incidentId}/evidences`, {
    userId: SECURITY,
    body: {
      type: 'note',
      description: '证据1',
      filePath: `/evidence/note-${seed}-1.txt`,
      fileHash: `sha256_${seed}_${Date.now()}`
    }
  });
  await request('POST', `/incidents/${incidentId}/foreman-review`, { userId: 'foreman-001' });
  await request('POST', `/incidents/${incidentId}/security-confirm`, { userId: SECURITY });
  await request('POST', `/incidents/${incidentId}/close`, { userId: ADMIN });
  return incidentId;
}

async function createOpenIncident(seed) {
  const resp = await request('POST', '/incidents', {
    userId: SECURITY,
    body: {
      title: `未结事故-${seed}`,
      level: 'low',
      description: `未结案描述-${seed}`,
      location: '测试地点'
    }
  });
  return resp.body.data.id;
}

async function main() {
  console.log('=== 事故保全包签收模块验证 ===\n');

  console.log('[启动服务] 清理数据库并启动');
  const started = await startServer(true);
  if (!started) {
    console.log('✗ 服务启动失败');
    process.exit(1);
  }
  console.log('  服务已启动\n');

  let testIncidentId = null;
  let receiptCode = null;
  let receiptPackageId = null;
  let archiveData = null;

  try {
    console.log('--- 场景1: 权限测试 ---');

    const reporterResp = await request('POST', '/receipts/packages', {
      userId: REPORTER,
      body: { incidentId: 'dummy' }
    });
    assert('普通上报人创建签收包返回403', reporterResp.status === 403,
      `实际状态码 ${reporterResp.status}`);
    assert('普通上报人创建签收包返回权限错误码',
      reporterResp.body && reporterResp.body.error && reporterResp.body.error.code === 'PERMISSION_DENIED',
      reporterResp.body ? JSON.stringify(reporterResp.body.error) : '无响应体');

    const noAuthResp = await request('POST', '/receipts/packages', {
      body: { incidentId: 'dummy' }
    });
    assert('无认证创建签收包返回401', noAuthResp.status === 401,
      `实际状态码 ${noAuthResp.status}`);

    console.log('');

    console.log('--- 场景2: 输入校验 ---');

    testIncidentId = await createClosedIncident('precheck');

    const noIncidentResp = await request('POST', '/receipts/packages', {
      userId: ADMIN,
      body: {}
    });
    assert('缺少 incidentId 返回400', noIncidentResp.status === 400);

    const openIncidentId = await createOpenIncident('open');
    const openResp = await request('POST', '/receipts/packages', {
      userId: ADMIN,
      body: { incidentId: openIncidentId }
    });
    assert('事故未结案返回400', openResp.status === 400);
    assert('事故未结案错误码正确',
      openResp.body && openResp.body.error && openResp.body.error.code === 'RECEIPT_INCIDENT_NOT_CLOSED');

    const noEvResp = await request('POST', '/incidents', {
      userId: SECURITY,
      body: { title: '无证据事故', level: 'low', description: 'x', location: 'y' }
    });
    const noEvId = noEvResp.body.data.id;
    await request('POST', `/incidents/${noEvId}/start-evidence`, { userId: SECURITY });
    await request('POST', `/incidents/${noEvId}/foreman-review`, { userId: 'foreman-001' });
    await request('POST', `/incidents/${noEvId}/security-confirm`, { userId: SECURITY });
    await request('POST', `/incidents/${noEvId}/close`, { userId: ADMIN });
    const noEvDetail = await request('GET', `/incidents/${noEvId}`, { userId: ADMIN });
    const noEvCreateResp = await request('POST', '/receipts/packages', {
      userId: ADMIN,
      body: { incidentId: noEvId }
    });
    assert('已结案但无证据返回400', noEvCreateResp.status === 400,
      `状态:${noEvDetail.body ? noEvDetail.body.data.status : '?'}, 响应:${JSON.stringify(noEvCreateResp.body)}`);
    assert('无证据错误码正确',
      noEvCreateResp.body && noEvCreateResp.body.error &&
      (noEvCreateResp.body.error.code === 'RECEIPT_NO_EVIDENCE' || noEvCreateResp.body.error.code === 'VALIDATION_ERROR'),
      noEvCreateResp.body ? JSON.stringify(noEvCreateResp.body.error) : 'null');

    console.log('');

    console.log('--- 场景3: 创建签收包成功 ---');

    const createResp = await request('POST', '/receipts/packages', {
      userId: ADMIN,
      body: {
        incidentId: testIncidentId,
        receiverName: '张三',
        deadlineHours: 24
      }
    });
    assert('创建签收包状态码201', createResp.status === 201,
      `实际 ${createResp.status} ${JSON.stringify(createResp.body)}`);
    assert('返回包含 id 字段', createResp.body && createResp.body.data && createResp.body.data.id);
    assert('返回包含明文签收码',
      createResp.body && createResp.body.data && typeof createResp.body.data.receiptCode === 'string' && createResp.body.data.receiptCode.length === 8);
    assert('返回包含事故快照',
      createResp.body && createResp.body.data && createResp.body.data.incidentSnapshot);
    assert('返回包含证据摘要',
      createResp.body && createResp.body.data && createResp.body.data.evidenceSummary);
    assert('返回包含审计摘要',
      createResp.body && createResp.body.data && createResp.body.data.auditSummary);
    assert('返回包含导出文件指纹',
      createResp.body && createResp.body.data && createResp.body.data.exportFingerprint);
    assert('返回包含签收截止时间',
      createResp.body && createResp.body.data && createResp.body.data.deadline);
    assert('状态为待签收',
      createResp.body && createResp.body.data && createResp.body.data.status === 'pending');

    if (createResp.status === 201 && createResp.body && createResp.body.data) {
      receiptCode = createResp.body.data.receiptCode;
      receiptPackageId = createResp.body.data.id;
      console.log(`    创建成功: 包ID=${receiptPackageId}, 签收码=${receiptCode}`);
    } else {
      console.log('    [!] 创建签收包失败，跳过后续相关测试');
    }

    console.log('');

    console.log('--- 场景4: 冲突策略测试 ---');

    if (receiptCode) {
      const conflictResp = await request('POST', '/receipts/packages', {
        userId: ADMIN,
        body: {
          incidentId: testIncidentId,
          conflictStrategy: 'error'
        }
      });
      assert('error 冲突策略返回409', conflictResp.status === 409,
        `实际 ${conflictResp.status} ${JSON.stringify(conflictResp.body)}`);
      assert('error 冲突策略返回 RECEIPT_CONFLICT 错误码',
        conflictResp.body && conflictResp.body.error && conflictResp.body.error.code === 'RECEIPT_CONFLICT');
      assert('冲突错误包含已有签收包信息',
        conflictResp.body && conflictResp.body.error && conflictResp.body.error.details && conflictResp.body.error.details.existingPackageId);

      const beforeListResp = await request('GET', '/receipts/packages', {
        userId: ADMIN,
        query: { incidentId: testIncidentId, status: 'pending' }
      });
      const beforePendingCount = beforeListResp.body ? beforeListResp.body.data.length : 0;

      const supersedeResp = await request('POST', '/receipts/packages', {
        userId: ADMIN,
        body: {
          incidentId: testIncidentId,
          conflictStrategy: 'supersede',
          receiverName: '李四'
        }
      });
      assert('supersede 策略创建成功', supersedeResp.status === 201,
        `实际 ${supersedeResp.status} ${JSON.stringify(supersedeResp.body)}`);

      const listAfterResp = await request('GET', '/receipts/packages', {
        userId: ADMIN,
        query: { incidentId: testIncidentId }
      });
      const pkgList = listAfterResp.body ? listAfterResp.body.data : [];
      assert('当前事故共2个签收包', pkgList.length === 2, `实际 ${pkgList.length}`);
      const revokedPkgs = pkgList.filter(p => p.status === 'revoked');
      const pendingPkgs = pkgList.filter(p => p.status === 'pending');
      assert('supersede 后旧包变为 revoked', revokedPkgs.length >= 1, `revoked ${revokedPkgs.length}`);
      assert('supersede 后新包为 pending', pendingPkgs.length === 1, `pending ${pendingPkgs.length}`);

      const newCode = supersedeResp.body.data.receiptCode;
      const oldCodeSignResp = await request('POST', '/receipts/sign', { body: { code: receiptCode, signerName: '测试' } });
      assert('被 superseded 的旧签收码无法使用', oldCodeSignResp.status === 410 || oldCodeSignResp.status === 409,
        `实际 ${oldCodeSignResp.status} ${JSON.stringify(oldCodeSignResp.body)}`);

      receiptCode = newCode;
      receiptPackageId = supersedeResp.body.data.id;
    } else {
      console.log('  [!] 场景3创建失败，跳过冲突策略测试');
    }

    console.log('');

    console.log('--- 场景5: 签收测试 ---');

    if (receiptCode) {
      const invalidResp = await request('POST', '/receipts/sign', { body: { code: 'XXXX1234' } });
      assert('无效签收码返回400', invalidResp.status === 400);
      assert('无效签收码错误码正确',
        invalidResp.body && invalidResp.body.error && invalidResp.body.error.code === 'RECEIPT_INVALID_CODE');

      const signResp = await request('POST', '/receipts/sign', {
        body: { code: receiptCode, signerName: '实际签收人' }
      });
      assert('正常签收成功', signResp.status === 200,
        `实际 ${signResp.status} ${JSON.stringify(signResp.body)}`);
      assert('签收后状态为 signed',
        signResp.body && signResp.body.data && signResp.body.data.status === 'signed');
      assert('签收记录包含签收人信息',
        signResp.body && signResp.body.data && signResp.body.data.signerName === '实际签收人');

      const dupResp = await request('POST', '/receipts/sign', {
        body: { code: receiptCode, signerName: '重复' }
      });
      assert('重复签收返回409', dupResp.status === 409);
      assert('重复签收错误码正确',
        dupResp.body && dupResp.body.error && dupResp.body.error.code === 'RECEIPT_ALREADY_SIGNED');
    } else {
      console.log('  [!] 没有可用签收码，跳过签收测试');
    }

    console.log('');

    console.log('--- 场景6: 撤销测试 ---');

    const revokeIncidentId = await createClosedIncident('revoke');
    const revokeResp = await request('POST', '/receipts/packages', {
      userId: ADMIN,
      body: { incidentId: revokeIncidentId, receiverName: '王五' }
    });
    let revokePkgIdForRestart = null;

    if (revokeResp.status === 201 && revokeResp.body && revokeResp.body.data) {
      const revokeCode = revokeResp.body.data.receiptCode;
      const revokePkgId = revokeResp.body.data.id;
      revokePkgIdForRestart = revokePkgId;

      const revokeActionResp = await request('POST', `/receipts/packages/${revokePkgId}/revoke`, {
        userId: ADMIN,
        body: { reason: '不再需要签收' }
      });
      assert('撤销签收包成功', revokeActionResp.status === 200,
        `实际 ${revokeActionResp.status} ${JSON.stringify(revokeActionResp.body)}`);
      assert('撤销后状态为 revoked',
        revokeActionResp.body && revokeActionResp.body.data && revokeActionResp.body.data.status === 'revoked');

      const revokedCodeSignResp = await request('POST', '/receipts/sign', {
        body: { code: revokeCode, signerName: '尝试签收已撤销' }
      });
      assert('已撤销签收码无法签收（返回410）',
        revokedCodeSignResp.status === 410,
        `实际 ${revokedCodeSignResp.status} ${JSON.stringify(revokedCodeSignResp.body)}`);
      assert('已撤销错误码正确',
        revokedCodeSignResp.body && revokedCodeSignResp.body.error &&
        (revokedCodeSignResp.body.error.code === 'RECEIPT_REVOKED' || revokedCodeSignResp.body.error.code === 'RECEIPT_ALREADY_SIGNED'),
        revokedCodeSignResp.body ? JSON.stringify(revokedCodeSignResp.body.error) : 'null');

      const dupRevokeResp = await request('POST', `/receipts/packages/${revokePkgId}/revoke`, {
        userId: ADMIN,
        body: { reason: '再次撤销' }
      });
      assert('重复撤销返回冲突', dupRevokeResp.status === 409,
        `实际 ${dupRevokeResp.status}`);

      const reporterRevokeResp = await request('POST', `/receipts/packages/${revokePkgId}/revoke`, {
        userId: REPORTER,
        body: { reason: '越权撤销' }
      });
      assert('普通上报人不能撤销签收包', reporterRevokeResp.status === 403);
    } else {
      console.log(`  [!] 撤销测试的签收包创建失败: ${revokeResp.status} ${JSON.stringify(revokeResp.body)}`);
    }

    const signedIncidentForRevoke = await createClosedIncident('signed-revoke');
    const signedPkgResp = await request('POST', '/receipts/packages', {
      userId: ADMIN,
      body: { incidentId: signedIncidentForRevoke }
    });
    if (signedPkgResp.status === 201 && signedPkgResp.body && signedPkgResp.body.data) {
      const signForRevokeResp = await request('POST', '/receipts/sign', {
        body: { code: signedPkgResp.body.data.receiptCode, signerName: '签收以测试撤销' }
      });
      if (signForRevokeResp.status === 200) {
        const tryRevokeSignedResp = await request('POST', `/receipts/packages/${signedPkgResp.body.data.id}/revoke`, {
          userId: ADMIN,
          body: { reason: '尝试撤销已签收' }
        });
        assert('已签收包不能撤销', tryRevokeSignedResp.status === 409,
          `实际 ${tryRevokeSignedResp.status} ${JSON.stringify(tryRevokeSignedResp.body)}`);
      } else {
        console.log(`  [!] 签收失败(测试撤销): ${signForRevokeResp.status}`);
      }
    }

    console.log('');

    console.log('--- 场景7: 列表与详情查询 ---');

    const listResp = await request('GET', '/receipts/packages', { userId: ADMIN });
    assert('列表查询成功', listResp.status === 200 && Array.isArray(listResp.body.data));

    if (receiptPackageId) {
      const detailResp = await request('GET', `/receipts/packages/${receiptPackageId}`, { userId: ADMIN });
      assert('详情查询成功', detailResp.status === 200 && detailResp.body.data.id === receiptPackageId);
    }

    const notFoundResp = await request('GET', '/receipts/packages/nonexistent-id', { userId: ADMIN });
    assert('不存在的签收包返回404', notFoundResp.status === 404);

    const reporterListResp = await request('GET', '/receipts/packages', { userId: REPORTER });
    assert('普通上报人不能查看列表', reporterListResp.status === 403);

    console.log('');

    console.log('--- 场景8: 导出中包含签收字段 ---');

    const jsonExportResp = await request('GET', '/export/incidents', {
      userId: ADMIN,
      query: { format: 'json' }
    });
    assert('JSON 导出成功', jsonExportResp.status === 200);
    const firstIncident = jsonExportResp.body && jsonExportResp.body.data && jsonExportResp.body.data[0];
    if (firstIncident) {
      assertHasKey('JSON 导出包含 receiptPackageCount 字段', firstIncident, 'receiptPackageCount');
      assertHasKey('JSON 导出包含 hasPendingReceipt 字段', firstIncident, 'hasPendingReceipt');
      assertHasKey('JSON 导出包含 lastReceiptStatus 字段', firstIncident, 'lastReceiptStatus');
    }

    const csvExportResp = await request('GET', '/export/incidents', {
      userId: ADMIN,
      query: { format: 'csv' }
    });
    assert('CSV 导出成功', csvExportResp.status === 200);
    const csvBody = (typeof csvExportResp.body === 'string') ? csvExportResp.body : (csvExportResp.raw || '');
    assert('CSV 头部包含签收相关列', csvBody.includes('签收包数量') && csvBody.includes('有待签收'),
      `CSV前200字符: ${csvBody.substring(0, 200)}`);

    console.log('');

    console.log('--- 场景9: 导出归档与再导入 ---');

    const exportArchiveResp = await request('GET', `/export/incident-archive/${testIncidentId}`, {
      userId: ADMIN,
      query: { download: 'true' }
    });
    assert('事故归档导出成功',
      exportArchiveResp.status === 200 && exportArchiveResp.body && (exportArchiveResp.body.files || exportArchiveResp.body.data),
      `实际 ${exportArchiveResp.status} body=${JSON.stringify(exportArchiveResp.body).substring(0, 200)}`);
    let archiveStruct = null;
    if (exportArchiveResp.status === 200 && exportArchiveResp.body) {
      if (exportArchiveResp.body.files) {
        archiveStruct = exportArchiveResp.body;
      } else if (exportArchiveResp.body.data && exportArchiveResp.body.data.files) {
        archiveStruct = exportArchiveResp.body.data;
      }
    }
    if (archiveStruct) {
      archiveData = archiveStruct;
      assert('归档包含 receipt_packages 文件',
        archiveStruct.files && archiveStruct.files['receipt_packages.json']);
      assert('归档包含 receipt_records 文件',
        archiveStruct.files && archiveStruct.files['receipt_records.json']);
      if (archiveStruct.files) {
        const archivePackages = JSON.parse(archiveStruct.files['receipt_packages.json'] || '[]');
        assert('归档中签收包非空', archivePackages.length > 0,
          `签收包数量: ${archivePackages.length}`);
        const archiveRecords = JSON.parse(archiveStruct.files['receipt_records.json'] || '[]');
        assert('归档中签收记录非空', archiveRecords.length > 0,
          `签收记录数量: ${archiveRecords.length}`);
      }
    }

    console.log('');

    console.log('--- 场景10: 跨重启数据持久化 ---');

    console.log('  [停止服务]');
    await stopServer();
    await new Promise(r => setTimeout(r, 1000));
    console.log('  [重启服务，保留数据库]');
    const restarted = await startServer(false);
    if (!restarted) {
      console.log('  ✗ 重启失败');
      process.exit(1);
    }

    const listAfterRestart = await request('GET', '/receipts/packages', { userId: ADMIN });
    assert('重启后能查询到签收包', listAfterRestart.status === 200 && listAfterRestart.body.data.length > 0);

    if (receiptPackageId) {
      const detailAfterRestart = await request('GET', `/receipts/packages/${receiptPackageId}`, { userId: ADMIN });
      assert('重启后能查询到已知签收包详情', detailAfterRestart.status === 200 && detailAfterRestart.body.data);
    }

    if (revokePkgIdForRestart) {
      const revokedAfterRestart = await request('GET', `/receipts/packages/${revokePkgIdForRestart}`, { userId: ADMIN });
      assert('重启后被撤销的包状态仍为 revoked',
        revokedAfterRestart.status === 200 && revokedAfterRestart.body.data && revokedAfterRestart.body.data.status === 'revoked',
        revokedAfterRestart.body ? JSON.stringify(revokedAfterRestart.body.data) : 'no data');
    }

    console.log('');

    console.log('--- 场景11: 导入归档，待签收包不恢复有效签收码 ---');

    if (archiveData) {
      const importResp = await request('POST', '/import/archive', {
        userId: ADMIN,
        query: { mode: 'commit', conflictStrategy: 'newId' },
        body: archiveData
      });
      assert('导入归档成功', importResp.status === 200 && importResp.body && importResp.body.success,
        `实际 ${importResp.status} ${JSON.stringify(importResp.body).substring(0, 300)}`);
      if (importResp.body && importResp.body.data) {
        assert('导入结果包含签收包数量',
          typeof importResp.body.data.receiptPackagesImported === 'number');
        assert('导入结果包含签收记录数量',
          typeof importResp.body.data.receiptRecordsImported === 'number');

        const newIncidentId = importResp.body.data.newIncidentId;
        if (newIncidentId) {
          const listImported = await request('GET', '/receipts/packages', {
            userId: ADMIN,
            query: { incidentId: newIncidentId }
          });
          const importedPkgs = listImported.body ? listImported.body.data : [];
          const pendingImported = importedPkgs.filter(p => p.status === 'pending');
          assert('导入后的签收包无 pending 状态（待签收到已置为 revoked）',
            pendingImported.length === 0,
            `pending 数量: ${pendingImported.length}, 状态列表: ${importedPkgs.map(p => p.status).join(',')}`);

          for (const p of importedPkgs) {
            const d = await request('GET', `/receipts/packages/${p.id}`, { userId: ADMIN });
            if (d.body && d.body.data && d.body.data.status === 'revoked' && d.body.data.revokeReason) {
              assert('导入后 revoked 包有明确的系统撤销原因',
                d.body.data.revokeReason.includes('导入归档') || d.body.data.revokeReason.includes('不恢复'));
            }
          }
        }
      }
    }

    console.log('');

    console.log('--- 场景12: 审计链路验证 ---');

    const auditResp = await request('GET', '/export/audit-logs', {
      userId: ADMIN,
      query: { limit: 100 }
    });
    if (auditResp.status === 200 && Array.isArray(auditResp.body.data)) {
      const actions = auditResp.body.data.map(l => l.action);
      assert('审计日志存在 receipt_created 动作', actions.includes('receipt_created'));
      assert('审计日志存在 receipt_signed 动作', actions.includes('receipt_signed'));
      assert('审计日志存在 receipt_revoked 动作', actions.includes('receipt_revoked'));
      assert('审计日志存在 receipt_create_failed 动作（失败也留审计）',
        actions.includes('receipt_create_failed'));
    }

  } catch (e) {
    console.error('测试过程异常:', e);
    console.error(e.stack);
    failCount++;
    failures.push(`测试异常: ${e.message}`);
  }

  console.log('\n=== 测试结果总结 ===');
  console.log(`通过: ${passCount}`);
  console.log(`失败: ${failCount}`);
  if (failures.length > 0) {
    console.log('\n失败详情:');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  }
  console.log(`\n${failCount === 0 ? '全部通过 ✓' : '存在失败 ✗'}`);

  if (serverProc) await stopServer();
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
