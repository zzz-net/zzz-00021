const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');

const BASE_URL = 'http://localhost:3000/api';
const ADMIN = 'admin-001';
const SECURITY = 'security-001';
const FOREMAN = 'foreman-001';
const REPORTER = 'reporter-001';
const SERVER_ENTRY = path.join(__dirname, '..', 'src', 'src', 'server.js');
const REAL_SERVER_ENTRY = path.join(__dirname, '..', 'src', 'server.js');

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

function canonicalize(obj) {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(canonicalize);
  if (typeof obj === 'object') {
    const sorted = {};
    for (const k of Object.keys(obj).sort()) sorted[k] = canonicalize(obj[k]);
    return sorted;
  }
  return obj;
}

function assertDeepEqual(label, actual, expected) {
  const actualC = JSON.stringify(canonicalize(actual));
  const expectedC = JSON.stringify(canonicalize(expected));
  const match = actualC === expectedC;
  if (match) {
    passCount++;
    console.log(`  ✓ ${label}`);
  } else {
    failCount++;
    const diff = [];
    const allKeys = new Set([...Object.keys(actual || {}), ...Object.keys(expected || {})]);
    for (const k of Array.from(allKeys).sort()) {
      const a = actual ? actual[k] : undefined;
      const e = expected ? expected[k] : undefined;
      if (JSON.stringify(canonicalize(a)) !== JSON.stringify(canonicalize(e))) {
        diff.push(`    ${k}: expected=${JSON.stringify(e)}, actual=${JSON.stringify(a)}`);
      }
    }
    const msg = diff.length > 0
      ? `${label}\n${diff.join('\n')}`
      : `${label} — expected=${JSON.stringify(expected)}, actual=${JSON.stringify(actual)}`;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

function waitForPort(port, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tryConnect = () => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.destroy();
        resolve(true);
      });
      sock.on('error', () => {
        if (Date.now() - start > timeoutMs) resolve(false);
        else setTimeout(tryConnect, 200);
      });
      sock.setTimeout(500);
    };
    tryConnect();
  });
}

function startServer() {
  return new Promise(async (resolve, reject) => {
    console.log('  启动服务...');
    serverStdoutBuf = '';
    serverStderrBuf = '';
    serverProc = spawn('node', [REAL_SERVER_ENTRY], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: '3000' }
    });
    serverProc.stdout.on('data', (d) => { serverStdoutBuf += d.toString(); });
    serverProc.stderr.on('data', (d) => { serverStderrBuf += d.toString(); });
    serverProc.on('error', (err) => reject(err));
    const ready = await waitForPort(3000, 10000);
    if (ready) {
      console.log('  ✓ 服务已启动');
      resolve(true);
    } else {
      reject(new Error('服务启动超时'));
    }
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!serverProc) { resolve(); return; }
    console.log('  停止服务...');
    let done = false;
    serverProc.on('exit', () => { done = true; resolve(); });
    serverProc.kill('SIGTERM');
    setTimeout(() => { if (!done) { serverProc.kill('SIGKILL'); } }, 3000);
    serverProc = null;
  });
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

process.on('SIGINT', () => {
  console.log('\n用户中断，正在清理...');
  stopServer().then(() => process.exit(130));
});

async function createTestIncident(userId, { title, level } = {}) {
  const res = await request('POST', '/incidents', {
    userId,
    body: {
      title: title || '交接班测试事故',
      description: '用于交接班模块验证测试',
      location: '测试区域',
      level: level || 'medium',
      occurredAt: new Date().toISOString()
    }
  });
  return res.body && res.body.data;
}

async function main() {
  console.log('========================================');
  console.log('  值班交接班模块验证脚本');
  console.log('========================================\n');

  try {
    await startServer();

    console.log('\n=== 阶段 1: 健康检查和初始化 ===');
    {
      const health = await request('GET', '/health');
      assert('健康检查返回 200', health.status === 200 && health.body && health.body.success);
    }

    console.log('\n=== 阶段 2: 无权限测试 (reporter 角色) ===');
    let testIncident1 = null;
    let testIncident2 = null;
    let handoverPending = null;
    {
      const r1 = await request('POST', '/shift-handovers', {
        userId: REPORTER,
        body: {
          takeoverUserId: FOREMAN,
          shiftStart: new Date().toISOString(),
          shiftEnd: new Date(Date.now() + 12 * 3600 * 1000).toISOString(),
          incidentIds: [],
          remark: 'reporter 试图创建交接班'
        }
      });
      assert('reporter 创建交接班返回 403', r1.status === 403);
      assert('reporter 创建交接班错误码 PERMISSION_DENIED',
        r1.body && r1.body.error && r1.body.error.code === 'PERMISSION_DENIED');

      testIncident1 = await createTestIncident(FOREMAN, { title: '交接班测试事故1' });
      assert('foreman 先创建事故用于测试', !!testIncident1 && testIncident1.id);
      testIncident2 = await createTestIncident(SECURITY, { title: '交接班测试事故2' });
      assert('security 再创建事故用于测试', !!testIncident2 && testIncident2.id);

      const createRes = await request('POST', '/shift-handovers', {
        userId: FOREMAN,
        body: {
          takeoverUserId: SECURITY,
          shiftStart: new Date().toISOString(),
          shiftEnd: new Date(Date.now() + 12 * 3600 * 1000).toISOString(),
          incidentIds: [testIncident1.id, testIncident2.id],
          remark: '白班交接，注意A区仓库漏水事故需补充维修记录'
        }
      });
      assert('foreman 创建交接班返回 201', createRes.status === 201);
      handoverPending = createRes.body && createRes.body.data;
      assert('交接班创建成功返回 data.id 存在', !!handoverPending && !!handoverPending.id);
      assert('交接班初始状态为 pending', handoverPending && handoverPending.status === 'pending');
      assert('交接班交班人为 foreman', handoverPending && handoverPending.handoverUserId === FOREMAN);
      assert('交接班接班人为 security', handoverPending && handoverPending.takeoverUserId === SECURITY);
      assert('交接班关联事故 ID 数组长度 2 个', handoverPending && Array.isArray(handoverPending.incidentIds) && handoverPending.incidentIds.length === 2);

      const r2 = await request('POST', `/shift-handovers/${handoverPending.id}/confirm`, { userId: REPORTER });
      assert('reporter 确认接班返回 403', r2.status === 403);
      assert('reporter 确认接班错误码 PERMISSION_DENIED',
        r2.body && r2.body.error && r2.body.error.code === 'PERMISSION_DENIED');

      const r3 = await request('POST', `/shift-handovers/${handoverPending.id}/revoke`, {
        userId: REPORTER,
        body: { reason: 'reporter 试撤回' }
      });
      assert('reporter 撤回交接返回 403', r3.status === 403);
      assert('reporter 撤回交接错误码 PERMISSION_DENIED',
        r3.body && r3.body.error && r3.body.error.code === 'PERMISSION_DENIED');
    }

    console.log('\n=== 阶段 3: 业务约束和冲突测试 ===');
    let handoverPendingForRevokeTest = null;
    {
      const invalidRes = await request('POST', '/shift-handovers', {
        userId: FOREMAN,
        body: {
          takeoverUserId: SECURITY,
          shiftStart: new Date().toISOString(),
          shiftEnd: new Date(Date.now() + 8 * 3600 * 1000).toISOString(),
          incidentIds: ['non-existent-incident-id-12345'],
          remark: '关联不存在事故'
        }
      });
      assert('关联不存在事故返回 400', invalidRes.status === 400);
      assert('关联不存在事故错误码 SHIFT_HANDOVER_INVALID_INCIDENT',
        invalidRes.body && invalidRes.body.error && invalidRes.body.error.code === 'SHIFT_HANDOVER_INVALID_INCIDENT');

      const wrongConfirmRes = await request('POST', `/shift-handovers/${handoverPending.id}/confirm`, { userId: FOREMAN });
      assert('非指定接班人(foreman) 尝试确认 security 的交接班返回 409', wrongConfirmRes.status === 409);
      assert('非接班人确认错误码 SHIFT_HANDOVER_CONFLICT',
        wrongConfirmRes.body && wrongConfirmRes.body.error && wrongConfirmRes.body.error.code === 'SHIFT_HANDOVER_CONFLICT');
      assert('非接班人确认 details.hint 存在', wrongConfirmRes.body && wrongConfirmRes.body.error && wrongConfirmRes.body.error.details && wrongConfirmRes.body.error.details.hint);

      const revokeCreate = await request('POST', '/shift-handovers', {
        userId: ADMIN,
        body: {
          takeoverUserId: SECURITY,
          shiftStart: new Date().toISOString(),
          shiftEnd: new Date(Date.now() + 8 * 3600 * 1000).toISOString(),
          incidentIds: [testIncident1.id],
          remark: '撤回测试用'
        }
      });
      handoverPendingForRevokeTest = revokeCreate.body.data;

      const wrongRevokeRes = await request('POST', `/shift-handovers/${handoverPendingForRevokeTest.id}/revoke`, {
        userId: SECURITY,
        body: { reason: '非交班人试撤回' }
      });
      assert('非交班人(security) 尝试撤回 admin 创建的交接班返回 409', wrongRevokeRes.status === 409);
      assert('非交班人撤回错误码 SHIFT_HANDOVER_NOT_CREATOR',
        wrongRevokeRes.body && wrongRevokeRes.body.error && wrongRevokeRes.body.error.code === 'SHIFT_HANDOVER_NOT_CREATOR');
    }

    console.log('\n=== 阶段 4: 重复确认冲突测试 ===');
    let handoverConfirmed = null;
    {
      const confirm1 = await request('POST', `/shift-handovers/${handoverPending.id}/confirm`, { userId: SECURITY });
      assert('security 作为接班人确认 pending 交接班成功', confirm1.status === 200 && confirm1.body && confirm1.body.success);
      handoverConfirmed = confirm1.body && confirm1.body.data;
      assert('确认后状态变为 confirmed', handoverConfirmed && handoverConfirmed.status === 'confirmed');
      assert('confirmedAt 字段被设置', !!handoverConfirmed && !!handoverConfirmed.confirmedAt);
      assert('confirmedByUserId 为 security', handoverConfirmed && handoverConfirmed.confirmedByUserId === SECURITY);

      const confirm2 = await request('POST', `/shift-handovers/${handoverPending.id}/confirm`, { userId: SECURITY });
      assert('已 confirmed 的交接班再次确认返回 409', confirm2.status === 409);
      assert('重复确认错误码 SHIFT_HANDOVER_ALREADY_CONFIRMED',
        confirm2.body && confirm2.body.error && confirm2.body.error.code === 'SHIFT_HANDOVER_ALREADY_CONFIRMED');
      assert('重复确认 details.currentStatus 为 confirmed',
        confirm2.body && confirm2.body.error && confirm2.body.error.details && confirm2.body.error.details.currentStatus === 'confirmed');
      assert('重复确认 details.hint 存在', confirm2.body && confirm2.body.error && confirm2.body.error.details && confirm2.body.error.details.hint);

      const revokeOnConfirmed = await request('POST', `/shift-handovers/${handoverPending.id}/revoke`, {
        userId: FOREMAN,
        body: { reason: '已确认后撤回' }
      });
      assert('已 confirmed 的交接班尝试撤回返回 409', revokeOnConfirmed.status === 409);
      assert('已确认撤回错误码 SHIFT_HANDOVER_ALREADY_CONFIRMED',
        revokeOnConfirmed.body && revokeOnConfirmed.body.error && revokeOnConfirmed.body.error.code === 'SHIFT_HANDOVER_ALREADY_CONFIRMED');
    }

    console.log('\n=== 阶段 5: 撤回限制测试 ===');
    let handoverRevoked = null;
    {
      const revoke1 = await request('POST', `/shift-handovers/${handoverPendingForRevokeTest.id}/revoke`, {
        userId: ADMIN,
        body: { reason: '交班人本人撤回' }
      });
      assert('交班人撤回 pending 交接班成功', revoke1.status === 200 && revoke1.body && revoke1.body.success);
      handoverRevoked = revoke1.body && revoke1.body.data;
      assert('撤回后状态变为 revoked', handoverRevoked && handoverRevoked.status === 'revoked');
      assert('revokedAt 字段被设置', !!handoverRevoked && !!handoverRevoked.revokedAt);
      assert('revokedByUserId 为 admin', handoverRevoked && handoverRevoked.revokedByUserId === ADMIN);
      assert('revokeReason 被记录', handoverRevoked && handoverRevoked.revokeReason === '交班人本人撤回');

      const revoke2 = await request('POST', `/shift-handovers/${handoverPendingForRevokeTest.id}/revoke`, {
        userId: ADMIN,
        body: { reason: '重复撤回' }
      });
      assert('已 revoked 的交接班再次撤回返回 409', revoke2.status === 409);
      assert('重复撤回错误码 SHIFT_HANDOVER_ALREADY_REVOKED',
        revoke2.body && revoke2.body.error && revoke2.body.error.code === 'SHIFT_HANDOVER_ALREADY_REVOKED');

      const confirmOnRevoked = await request('POST', `/shift-handovers/${handoverPendingForRevokeTest.id}/confirm`, { userId: SECURITY });
      assert('已 revoked 的交接班尝试确认返回 409', confirmOnRevoked.status === 409);
      assert('已撤回确认错误码 SHIFT_HANDOVER_ALREADY_REVOKED',
        confirmOnRevoked.body && confirmOnRevoked.body.error && confirmOnRevoked.body.error.code === 'SHIFT_HANDOVER_ALREADY_REVOKED');
    }

    console.log('\n=== 阶段 6: 交接班详情和列表 ===');
    let handoverForPersist = null;
    let handoverConfirmedForPersist = null;
    let handoverRevokedForPersist = null;
    {
      const detailRes = await request('GET', `/shift-handovers/${handoverPending.id}`, { userId: FOREMAN });
      assert('获取交接班详情 200', detailRes.status === 200 && detailRes.body && detailRes.body.success);
      const detail = detailRes.body && detailRes.body.data;
      assert('详情 incidents 字段存在', detail && Array.isArray(detail.incidents));
      assert('详情关联事故数为 2 个', detail && detail.incidents.length === 2);

      const listRes = await request('GET', '/shift-handovers', { userId: ADMIN });
      assert('交接班列表 200', listRes.status === 200 && listRes.body && listRes.body.success);
      const list = listRes.body && listRes.body.data;
      assert('交接班列表至少 3 条以上', list && list.length >= 3);

      const pendingList = await request('GET', '/shift-handovers', { userId: ADMIN, query: { status: 'pending' } });
      assert('按 pending 筛选返回数组', pendingList.body && Array.isArray(pendingList.body.data));

      const createForPersist1 = await request('POST', '/shift-handovers', {
        userId: FOREMAN,
        body: {
          takeoverUserId: SECURITY,
          shiftStart: '2026-06-08T08:00:00.000Z',
          shiftEnd: '2026-06-08T20:00:00.000Z',
          incidentIds: [testIncident1.id],
          remark: '持久化测试-pending'
        }
      });
      handoverForPersist = createForPersist1.body.data;
      assert('持久化测试 pending 交接班创建', !!handoverForPersist);

      const createForPersist2 = await request('POST', '/shift-handovers', {
        userId: FOREMAN,
        body: {
          takeoverUserId: SECURITY,
          shiftStart: '2026-06-08T20:00:00.000Z',
          shiftEnd: '2026-06-09T08:00:00.000Z',
          incidentIds: [testIncident2.id],
          remark: '持久化测试-confirmed'
        }
      });
      handoverConfirmedForPersist = createForPersist2.body.data;
      await request('POST', `/shift-handovers/${handoverConfirmedForPersist.id}/confirm`, { userId: SECURITY });

      const createForPersist3 = await request('POST', '/shift-handovers', {
        userId: FOREMAN,
        body: {
          takeoverUserId: SECURITY,
          shiftStart: '2026-06-09T08:00:00.000Z',
          shiftEnd: '2026-06-09T20:00:00.000Z',
          incidentIds: [],
          remark: '持久化测试-revoked'
        }
      });
      handoverRevokedForPersist = createForPersist3.body.data;
      await request('POST', `/shift-handovers/${handoverRevokedForPersist.id}/revoke`, { userId: FOREMAN, body: { reason: '持久化撤回测试' } });
    }

    console.log('\n=== 阶段 7: 跨重启持久化测试 ===');
    {
      await stopServer();
      await sleep(1500);
      await startServer();

      const listAfter = await request('GET', '/shift-handovers', { userId: ADMIN });
      assert('重启后列表接口正常', listAfter.status === 200 && listAfter.body && listAfter.body.success);

      const detailPendingAfter = await request('GET', `/shift-handovers/${handoverForPersist.id}`, { userId: ADMIN });
      assert('重启后 pending 交接班可读', detailPendingAfter.status === 200 && detailPendingAfter.body && detailPendingAfter.body.success);
      const dPending = detailPendingAfter.body.data;
      assert('重启后 pending 状态保留', dPending && dPending.status === 'pending');
      assert('重启后交班人保留', dPending && dPending.handoverUserId === FOREMAN);
      assert('重启后接班人保留', dPending && dPending.takeoverUserId === SECURITY);
      assert('重启后班次时间保留',
        dPending && dPending.shiftStart === '2026-06-08T08:00:00.000Z');
      assert('重启后关联事故保留',
        dPending && Array.isArray(dPending.incidentIds) && dPending.incidentIds.length === 1 && dPending.incidentIds[0] === testIncident1.id);
      assert('重启后备注保留', dPending && dPending.remark === '持久化测试-pending');

      const detailConfirmedAfter = await request('GET', `/shift-handovers/${handoverConfirmedForPersist.id}`, { userId: ADMIN });
      assert('重启后 confirmed 交接班可读', detailConfirmedAfter.status === 200);
      const dConfirmed = detailConfirmedAfter.body.data;
      assert('重启后 confirmed 状态保留', dConfirmed && dConfirmed.status === 'confirmed');
      assert('重启后 confirmedAt 保留', dConfirmed && !!dConfirmed.confirmedAt);

      const detailRevokedAfter = await request('GET', `/shift-handovers/${handoverRevokedForPersist.id}`, { userId: ADMIN });
      assert('重启后 revoked 交接班可读', detailRevokedAfter.status === 200);
      const dRevoked = detailRevokedAfter.body.data;
      assert('重启后 revoked 状态保留', dRevoked && dRevoked.status === 'revoked');
      assert('重启后 revokedAt 保留', dRevoked && !!dRevoked.revokedAt);
      assert('重启后 revokeReason 保留', dRevoked && dRevoked.revokeReason === '持久化撤回测试');
    }

    console.log('\n=== 阶段 8: 审计日志落库验证 ===');
    {
      let auditLogs = [];
      try {
        const auditModule = require(path.join(__dirname, '..', 'src', 'services', 'auditService'));
        auditLogs = auditModule.getAuditLogs({});
      } catch(e) {
        console.error('无法加载 auditService:', e.message);
      }

      const createdLogs = auditLogs.filter(l => l.action === 'shift_handover_created');
      assert('存在 shift_handover_created 审计日志', createdLogs.length >= 1);
      if (createdLogs.length > 0) {
        const l = createdLogs[createdLogs.length - 1];
        assert('created 日志 userId 正确', l.userId === FOREMAN || l.userId === ADMIN);
        assert('created 日志 to 状态 pending', (l.details && l.details.to === 'pending') || l.currentStatus === 'pending');
        assert('created 日志 details.handoverId 存在', l.details && l.details.handoverId);
      }

      const confirmedLogs = auditLogs.filter(l => l.action === 'shift_handover_confirmed');
      assert('存在 shift_handover_confirmed 审计日志', confirmedLogs.length >= 1);
      if (confirmedLogs.length > 0) {
        const l = confirmedLogs[confirmedLogs.length - 1];
        assert('confirmed 日志 userId 为 security', l.userId === SECURITY);
        assert('confirmed 日志 from pending', (l.details && l.details.from === 'pending') || l.previousStatus === 'pending');
        assert('confirmed 日志 to confirmed', (l.details && l.details.to === 'confirmed') || l.currentStatus === 'confirmed');
      }

      const revokedLogs = auditLogs.filter(l => l.action === 'shift_handover_revoked');
      assert('存在 shift_handover_revoked 审计日志', revokedLogs.length >= 1);
      if (revokedLogs.length > 0) {
        const l = revokedLogs[0];
        assert('revoked 日志 from pending', (l.details && l.details.from === 'pending') || l.previousStatus === 'pending');
        assert('revoked 日志 to revoked', (l.details && l.details.to === 'revoked') || l.currentStatus === 'revoked');
      }

      const createFailedLogs = auditLogs.filter(l => l.action === 'shift_handover_create_failed');
      assert('存在 shift_handover_create_failed 审计日志（reporter 无权限）', createFailedLogs.length >= 1);

      const confirmFailedLogs = auditLogs.filter(l => l.action === 'shift_handover_confirm_failed');
      assert('存在 shift_handover_confirm_failed 审计日志', confirmFailedLogs.length >= 1);

      const revokeFailedLogs = auditLogs.filter(l => l.action === 'shift_handover_revoke_failed');
      assert('存在 shift_handover_revoke_failed 审计日志', revokeFailedLogs.length >= 1);
    }

    console.log('\n========================================');
    console.log(`  总计: 通过 ${passCount} / ${passCount + failCount}`);
    if (failCount > 0) {
      console.log('  失败项:');
      failures.forEach((f, i) => console.log(`    ${i + 1}. ${f}`));
    }
    console.log('========================================');

    await stopServer();
    process.exit(failCount > 0 ? 1 : 0);
  } catch (err) {
    console.error('执行异常:', err);
    console.error('stdout:', serverStdoutBuf);
    console.error('stderr:', serverStderrBuf);
    await stopServer();
    process.exit(2);
  }
}

main();
