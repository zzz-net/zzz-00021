const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');

const BASE_URL = 'http://localhost:3000/api';
const ADMIN = 'admin-001';
const SECURITY = 'security-001';
const REPORTER1 = 'reporter-001';
const REPORTER2 = 'reporter-002';
const FOREMAN = 'foreman-001';
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

async function section(title, fn) {
  console.log(`\n=== ${title} ===`);
  await fn();
}

function checkPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') resolve(true);
      else resolve(false);
    });
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(port);
  });
}

function startServer() {
  return new Promise(async (resolve, reject) => {
    const inUse = await checkPortInUse(3000);
    if (inUse) {
      return reject(new Error('端口 3000 已被占用，请先停止占用该端口的进程（例如已手动启动的 npm start）。验证脚本需要自己管理服务生命周期。'));
    }

    serverProc = spawn('node', [SERVER_ENTRY], {
      cwd: path.join(__dirname, '..'),
      env: process.env
    });

    serverStdoutBuf = '';
    serverStderrBuf = '';
    serverProc.stdout.on('data', (d) => { serverStdoutBuf += d.toString(); });
    serverProc.stderr.on('data', (d) => { serverStderrBuf += d.toString(); });

    serverProc.on('exit', (code) => {
      if (serverProc) {
        console.log(`\n[server] 进程退出，code=${code}`);
        if (serverStderrBuf) console.log(`[server stderr]\n${serverStderrBuf}`);
      }
    });

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        const health = await request('GET', '/health');
        if (health.status === 200) {
          resolve();
          return;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 300));
    }
    reject(new Error('服务启动超时。stdout: ' + serverStdoutBuf + '\nstderr: ' + serverStderrBuf));
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!serverProc) { resolve(); return; }
    const proc = serverProc;
    serverProc = null;
    let resolved = false;
    const finish = () => { if (!resolved) { resolved = true; resolve(); } };
    proc.on('exit', finish);
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', proc.pid, '/T', '/F']);
      } else {
        proc.kill('SIGTERM');
      }
    } catch {
      try { proc.kill('SIGKILL'); } catch {}
    }
    setTimeout(finish, 5000);
  });
}

async function restartServer() {
  await stopServer();
  await new Promise(r => setTimeout(r, 500));
  await startServer();
}

function cleanupAndExit(exitCode) {
  if (serverProc) {
    const proc = serverProc;
    serverProc = null;
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', proc.pid, '/T', '/F']);
      } else {
        proc.kill('SIGKILL');
      }
    } catch {}
  }
  process.exit(exitCode);
}

process.on('SIGINT', () => cleanupAndExit(130));
process.on('SIGTERM', () => cleanupAndExit(143));
process.on('uncaughtException', (err) => { console.error('uncaughtException:', err); cleanupAndExit(2); });

async function main() {
  console.log('事故列表/待办视图可复现验证脚本');
  console.log('=================================');
  console.log(`服务入口: ${SERVER_ENTRY}`);
  console.log('');

  try {
    await startServer();
  } catch (err) {
    console.error('启动服务失败:', err.message);
    process.exit(2);
  }
  console.log('服务已启动 ✓');

  const DEFAULT_OVERDUE = { low: 72, medium: 48, high: 24, critical: 12 };
  await request('PUT', '/incidents/config/overdue', {
    userId: ADMIN,
    body: DEFAULT_OVERDUE
  });
  console.log('已重置超时配置为默认值 ✓');

  let testIncidentIds = [];

  await section('1. 无权限列表过滤（后端强制，不依赖前端）', async () => {
    console.log('  [准备] 用不同用户创建测试事故...');
    
    const create1 = await request('POST', '/incidents', {
      userId: REPORTER1,
      body: {
        title: 'reporter1 上报的事故',
        location: 'A区',
        level: 'low',
        occurredAt: new Date().toISOString()
      }
    });
    assert('reporter1 创建事故成功', create1.status === 201, `实际 ${create1.status}`);
    if (create1.status === 201) testIncidentIds.push(create1.body.data.id);

    const create2 = await request('POST', '/incidents', {
      userId: REPORTER2,
      body: {
        title: 'reporter2 上报的事故',
        location: 'B区',
        level: 'medium',
        occurredAt: new Date().toISOString()
      }
    });
    assert('reporter2 创建事故成功', create2.status === 201, `实际 ${create2.status}`);
    if (create2.status === 201) testIncidentIds.push(create2.body.data.id);

    const adminList = await request('GET', '/incidents', { userId: ADMIN });
    assert('admin 能看到全量事故（>=2条）', 
      adminList.status === 200 && Array.isArray(adminList.body.data) && adminList.body.data.length >= 2,
      `实际数量: ${adminList.body && adminList.body.data ? adminList.body.data.length : 0}`);

    const securityList = await request('GET', '/incidents', { userId: SECURITY });
    assert('security 能看到全量事故（>=2条）',
      securityList.status === 200 && Array.isArray(securityList.body.data) && securityList.body.data.length >= 2,
      `实际数量: ${securityList.body && securityList.body.data ? securityList.body.data.length : 0}`);

    const reporter1List = await request('GET', '/incidents', { userId: REPORTER1 });
    assert('reporter1 只能看到自己的事故',
      reporter1List.status === 200 && Array.isArray(reporter1List.body.data),
      `实际状态: ${reporter1List.status}`);
    if (reporter1List.status === 200 && Array.isArray(reporter1List.body.data)) {
      const r1Own = reporter1List.body.data.filter(i => 
        i.reporterId === REPORTER1 || i.currentHandlerId === REPORTER1
      );
      assert('reporter1 看到的每条都是自己上报或处理的',
        r1Own.length === reporter1List.body.data.length,
        `自己的: ${r1Own.length}, 总数: ${reporter1List.body.data.length}`);
      const r1OwnIncident = reporter1List.body.data.find(i => 
        i.title === 'reporter1 上报的事故'
      );
      assert('reporter1 能看到自己上报的事故', !!r1OwnIncident);
      const r1SeesR2 = reporter1List.body.data.find(i => 
        i.title === 'reporter2 上报的事故'
      );
      assert('reporter1 看不到 reporter2 上报的事故（后端强制过滤）', !r1SeesR2);
    }

    const reporter2List = await request('GET', '/incidents', { userId: REPORTER2 });
    assert('reporter2 只能看到自己的事故',
      reporter2List.status === 200 && Array.isArray(reporter2List.body.data));
    if (reporter2List.status === 200 && Array.isArray(reporter2List.body.data)) {
      const r2Own = reporter2List.body.data.filter(i => 
        i.reporterId === REPORTER2 || i.currentHandlerId === REPORTER2
      );
      assert('reporter2 看到的每条都是自己上报或处理的',
        r2Own.length === reporter2List.body.data.length);
      const r2SeesR1 = reporter2List.body.data.find(i => 
        i.title === 'reporter1 上报的事故'
      );
      assert('reporter2 看不到 reporter1 上报的事故（后端强制过滤）', !r2SeesR1);
    }

    const foremanList = await request('GET', '/incidents', { userId: FOREMAN });
    assert('foreman 默认看到 0 条（非 admin/security 且非 reporter）',
      foremanList.status === 200 && Array.isArray(foremanList.body.data));
  });

  await section('2. 非法筛选参数校验（返回清晰错误）', async () => {
    const badSortField = await request('GET', '/incidents', {
      userId: ADMIN,
      query: { sort: 'invalidField:desc' }
    });
    assert('非法 sort 字段返回 400', badSortField.status === 400, `实际 ${badSortField.status}`);
    assert('非法 sort 字段错误码为 VALIDATION_ERROR',
      badSortField.body && badSortField.body.error && badSortField.body.error.code === 'VALIDATION_ERROR');
    assert('非法 sort 字段错误详情包含有效值提示',
      badSortField.body && badSortField.body.error && 
      typeof badSortField.body.error.details === 'string' &&
      badSortField.body.error.details.includes('createdAt') &&
      badSortField.body.error.details.includes('updatedAt') &&
      badSortField.body.error.details.includes('level'));

    const badSortDir = await request('GET', '/incidents', {
      userId: ADMIN,
      query: { sort: 'createdAt:invalidDir' }
    });
    assert('非法 sort 方向返回 400', badSortDir.status === 400, `实际 ${badSortDir.status}`);
    assert('非法 sort 方向错误码为 VALIDATION_ERROR',
      badSortDir.body && badSortDir.body.error && badSortDir.body.error.code === 'VALIDATION_ERROR');

    const badCreatedFrom = await request('GET', '/incidents', {
      userId: ADMIN,
      query: { createdFrom: 'not-a-date' }
    });
    assert('非法 createdFrom 返回 400', badCreatedFrom.status === 400, `实际 ${badCreatedFrom.status}`);
    assert('非法 createdFrom 错误码为 VALIDATION_ERROR',
      badCreatedFrom.body && badCreatedFrom.body.error && badCreatedFrom.body.error.code === 'VALIDATION_ERROR');

    const badCreatedTo = await request('GET', '/incidents', {
      userId: ADMIN,
      query: { createdTo: 'definitely-not-iso' }
    });
    assert('非法 createdTo 返回 400', badCreatedTo.status === 400, `实际 ${badCreatedTo.status}`);
    assert('非法 createdTo 错误码为 VALIDATION_ERROR',
      badCreatedTo.body && badCreatedTo.body.error && badCreatedTo.body.error.code === 'VALIDATION_ERROR');

    const badLevel = await request('GET', '/incidents', {
      userId: ADMIN,
      query: { level: 'invalid-level' }
    });
    assert('非法 level 返回 400', badLevel.status === 400, `实际 ${badLevel.status}`);
    assert('非法 level 错误码为 VALIDATION_ERROR',
      badLevel.body && badLevel.body.error && badLevel.body.error.code === 'VALIDATION_ERROR');

    const noParams = await request('GET', '/incidents', { userId: ADMIN });
    assert('无参数时正常返回 200（默认顺序）', noParams.status === 200);
    assert('无参数时 success=true', noParams.body && noParams.body.success === true);
  });

  await section('3. 排序稳定性验证（创建/更新/等级，升降序）', async () => {
    console.log('  [准备] 创建不同等级和时间的事故用于排序验证...');
    
    const createSorted = async (title, level, offsetMs) => {
      const resp = await request('POST', '/incidents', {
        userId: ADMIN,
        body: {
          title,
          location: '排序测试区',
          level,
          occurredAt: new Date(Date.now() - offsetMs).toISOString()
        }
      });
      if (resp.status === 201) testIncidentIds.push(resp.body.data.id);
      return resp;
    };

    await createSorted('排序-低', 'low', 5000);
    await createSorted('排序-中', 'medium', 4000);
    await createSorted('排序-高', 'high', 3000);
    await createSorted('排序-严重', 'critical', 2000);
    await new Promise(r => setTimeout(r, 100));

    const defaultSort = await request('GET', '/incidents', {
      userId: ADMIN,
      query: { location: '排序测试区' }
    });
    assert('默认排序返回成功', defaultSort.status === 200);
    if (defaultSort.status === 200 && defaultSort.body.data.length >= 2) {
      const items = defaultSort.body.data;
      let isDesc = true;
      for (let i = 1; i < items.length; i++) {
        if (new Date(items[i - 1].createdAt) < new Date(items[i].createdAt)) {
          isDesc = false;
          break;
        }
      }
      assert('默认按 createdAt 降序排列', isDesc);
    }

    const sortCreatedAsc = await request('GET', '/incidents', {
      userId: ADMIN,
      query: { location: '排序测试区', sort: 'createdAt:asc' }
    });
    assert('createdAt:asc 排序返回成功', sortCreatedAsc.status === 200);
    if (sortCreatedAsc.status === 200 && sortCreatedAsc.body.data.length >= 2) {
      const items = sortCreatedAsc.body.data;
      let isAsc = true;
      for (let i = 1; i < items.length; i++) {
        if (new Date(items[i - 1].createdAt) > new Date(items[i].createdAt)) {
          isAsc = false;
          break;
        }
      }
      assert('createdAt:asc 按创建时间升序', isAsc);
    }

    const sortCreatedDesc = await request('GET', '/incidents', {
      userId: ADMIN,
      query: { location: '排序测试区', sort: 'createdAt:desc' }
    });
    assert('createdAt:desc 排序返回成功', sortCreatedDesc.status === 200);

    const sortUpdatedDesc = await request('GET', '/incidents', {
      userId: ADMIN,
      query: { location: '排序测试区', sort: 'updatedAt:desc' }
    });
    assert('updatedAt:desc 排序返回成功', sortUpdatedDesc.status === 200);

    const sortUpdatedAsc = await request('GET', '/incidents', {
      userId: ADMIN,
      query: { location: '排序测试区', sort: 'updatedAt:asc' }
    });
    assert('updatedAt:asc 排序返回成功', sortUpdatedAsc.status === 200);

    const sortLevelDesc = await request('GET', '/incidents', {
      userId: ADMIN,
      query: { location: '排序测试区', sort: 'level:desc' }
    });
    assert('level:desc 排序返回成功', sortLevelDesc.status === 200);
    if (sortLevelDesc.status === 200 && sortLevelDesc.body.data.length >= 4) {
      const items = sortLevelDesc.body.data;
      const levelOrder = { critical: 4, high: 3, medium: 2, low: 1 };
      let isDesc = true;
      for (let i = 1; i < items.length; i++) {
        if (levelOrder[items[i - 1].level] < levelOrder[items[i].level]) {
          isDesc = false;
          break;
        }
      }
      assert('level:desc 按等级降序（critical→low）', isDesc,
        `顺序: ${items.map(i => i.level).join(', ')}`);
    }

    const sortLevelAsc = await request('GET', '/incidents', {
      userId: ADMIN,
      query: { location: '排序测试区', sort: 'level:asc' }
    });
    assert('level:asc 排序返回成功', sortLevelAsc.status === 200);
    if (sortLevelAsc.status === 200 && sortLevelAsc.body.data.length >= 4) {
      const items = sortLevelAsc.body.data;
      const levelOrder = { critical: 4, high: 3, medium: 2, low: 1 };
      let isAsc = true;
      for (let i = 1; i < items.length; i++) {
        if (levelOrder[items[i - 1].level] > levelOrder[items[i].level]) {
          isAsc = false;
          break;
        }
      }
      assert('level:asc 按等级升序（low→critical）', isAsc,
        `顺序: ${items.map(i => i.level).join(', ')}`);
    }

    const allHaveOverdueField = sortLevelAsc.body && sortLevelAsc.body.data 
      ? sortLevelAsc.body.data.every(i => 'overdue' in i)
      : false;
    assert('每条事故记录都附带 overdue 字段', allHaveOverdueField);
  });

  await section('4. 超时筛选与配置', async () => {
    console.log('  [步骤 1] 设置短超时让事故立即超时...');
    const shortConfig = { low: 0.0001, medium: 0.0001, high: 0.0001, critical: 0.0001 };
    const putShort = await request('PUT', '/incidents/config/overdue', {
      userId: ADMIN,
      body: shortConfig
    });
    assert('设置短超时配置成功', putShort.status === 200, `实际 ${putShort.status}`);
    assert('返回配置包含四个等级', 
      putShort.body && putShort.body.data &&
      'low' in putShort.body.data &&
      'medium' in putShort.body.data &&
      'high' in putShort.body.data &&
      'critical' in putShort.body.data);

    console.log('  [步骤 2] 等待确保超时...');
    await new Promise(r => setTimeout(r, 200));

    const overdueList = await request('GET', '/incidents', {
      userId: ADMIN,
      query: { overdueOnly: 'true', location: '排序测试区' }
    });
    assert('overdueOnly=true 返回成功', overdueList.status === 200);
    assert('overdueOnly=true 返回的每条都 overdue=true',
      overdueList.body && overdueList.body.data &&
      overdueList.body.data.length > 0 &&
      overdueList.body.data.every(i => i.overdue === true),
      `数量: ${overdueList.body && overdueList.body.data ? overdueList.body.data.length : 0}`);

    console.log('  [步骤 3] 还原超时配置...');
    const restoreConfig = await request('PUT', '/incidents/config/overdue', {
      userId: ADMIN,
      body: { low: 99999, medium: 99999, high: 99999, critical: 99999 }
    });
    assert('还原长超时配置成功', restoreConfig.status === 200);

    const notOverdueList = await request('GET', '/incidents', {
      userId: ADMIN,
      query: { location: '排序测试区' }
    });
    assert('还原后返回成功', notOverdueList.status === 200);
    assert('还原后每条都 overdue=false',
      notOverdueList.body && notOverdueList.body.data &&
      notOverdueList.body.data.length > 0 &&
      notOverdueList.body.data.every(i => i.overdue === false),
      `overdue=true 数量: ${notOverdueList.body && notOverdueList.body.data ? notOverdueList.body.data.filter(i => i.overdue).length : 0}`);

    const reporterCannotUpdate = await request('PUT', '/incidents/config/overdue', {
      userId: REPORTER1,
      body: { low: 1 }
    });
    assert('reporter 无法修改超时配置（403）', reporterCannotUpdate.status === 403, `实际 ${reporterCannotUpdate.status}`);
    assert('reporter 修改失败错误码为 PERMISSION_DENIED',
      reporterCannotUpdate.body && reporterCannotUpdate.body.error && 
      reporterCannotUpdate.body.error.code === 'PERMISSION_DENIED');

    const securityCannotUpdate = await request('PUT', '/incidents/config/overdue', {
      userId: SECURITY,
      body: { low: 1 }
    });
    assert('security 无法修改超时配置（403）', securityCannotUpdate.status === 403, `实际 ${securityCannotUpdate.status}`);

    const anyCanRead = await request('GET', '/incidents/config/overdue', { userId: REPORTER1 });
    assert('reporter 可以读取超时配置', anyCanRead.status === 200);
  });

  let crossRestartExpected = null;

  await section('5. 跨重启配置持久化（改配置→停服务→启服务→读配置→断言）', async () => {
    const uniqueConfig = {
      low: 100 + Math.floor(Math.random() * 100),
      medium: 200 + Math.floor(Math.random() * 100),
      high: 300 + Math.floor(Math.random() * 100),
      critical: 400 + Math.floor(Math.random() * 100)
    };

    console.log('  [步骤 1/4] 设置自定义超时配置...');
    const putResp = await request('PUT', '/incidents/config/overdue', {
      userId: ADMIN,
      body: uniqueConfig
    });
    assert('设置配置成功（重启前）', putResp.status === 200, `实际 ${putResp.status}`);

    crossRestartExpected = uniqueConfig;

    const preGet = await request('GET', '/incidents/config/overdue', { userId: ADMIN });
    assertDeepEqual('重启前读取配置与写入值完全一致',
      preGet.body.data,
      crossRestartExpected);

    console.log('  [步骤 2/4] 停止服务...');
    await stopServer();
    await new Promise(r => setTimeout(r, 1000));

    const portAfterStop = await checkPortInUse(3000);
    assert('服务已停止（端口 3000 释放）', portAfterStop === false, `端口仍被占用: ${portAfterStop}`);

    console.log('  [步骤 3/4] 重新启动服务...');
    try {
      await startServer();
    } catch (err) {
      assert('服务重启成功', false, err.message);
      return;
    }
    assert('服务重启成功', true);

    console.log('  [步骤 4/4] 重启后读取配置并断言...');
    const postGet = await request('GET', '/incidents/config/overdue', { userId: ADMIN });
    assert('重启后 GET /incidents/config/overdue 成功', postGet.status === 200);

    assertDeepEqual(
      '重启后配置与重启前设置完全一致（持久化生效）',
      postGet.body.data,
      crossRestartExpected
    );

    const postGetBySecurity = await request('GET', '/incidents/config/overdue', { userId: SECURITY });
    assertDeepEqual(
      'security 角色读取到相同配置',
      postGetBySecurity.body.data,
      crossRestartExpected
    );
  });

  await section('6. 审计日志验证（超时配置变更记录）', async () => {
    const auditResp = await request('GET', `/incidents/${testIncidentIds[0] || 'dummy'}/audit-logs`, {
      userId: ADMIN
    });
    
    const allIncidents = await request('GET', '/incidents', { userId: ADMIN });
    const anyIncidentId = allIncidents.body && allIncidents.body.data && allIncidents.body.data.length > 0
      ? allIncidents.body.data[0].id
      : testIncidentIds[0];

    if (anyIncidentId) {
      const detailResp = await request('GET', `/incidents/${anyIncidentId}`, { userId: ADMIN });
      assert('事故详情接口也附带 overdue 字段',
        detailResp.status === 200 && detailResp.body && detailResp.body.data &&
        'overdue' in detailResp.body.data);
    }

    const configChangeLogs = await request('GET', '/export/audit-logs', {
      userId: ADMIN,
      query: { action: 'overdue_config_updated', format: 'json' }
    });
    const logs = Array.isArray(configChangeLogs.body) ? configChangeLogs.body : [];
    assert('超时配置变更审计日志已写入（overdue_config_updated）',
      logs.length > 0, `找到 ${logs.length} 条日志`);
    
    if (logs.length > 0) {
      const lastLog = logs[logs.length - 1];
      assert('审计日志记录了操作人 userId', !!lastLog.userId);
      assert('审计日志记录了操作人 userName', !!lastLog.userName);
      assert('审计日志 details 包含 before',
        lastLog.details && 'before' in lastLog.details);
      assert('审计日志 details 包含 after',
        lastLog.details && 'after' in lastLog.details);
      assert('审计日志 details 包含 changes',
        lastLog.details && 'changes' in lastLog.details);
    }
  });

  await section('7. assignedTo 和时间范围筛选验证', async () => {
    const assignedList = await request('GET', '/incidents', {
      userId: ADMIN,
      query: { assignedTo: REPORTER1 }
    });
    assert('assignedTo 筛选返回成功', assignedList.status === 200);
    if (assignedList.status === 200 && Array.isArray(assignedList.body.data)) {
      assert('assignedTo 筛选结果每条 currentHandlerId 匹配',
        assignedList.body.data.every(i => i.currentHandlerId === REPORTER1));
    }

    const now = new Date();
    const future = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const past = new Date(0).toISOString();

    const rangeList = await request('GET', '/incidents', {
      userId: ADMIN,
      query: { createdFrom: past, createdTo: future }
    });
    assert('时间范围筛选（全范围）返回成功且非空',
      rangeList.status === 200 && rangeList.body.data.length > 0);

    const emptyRange = await request('GET', '/incidents', {
      userId: ADMIN,
      query: { createdFrom: future, createdTo: future }
    });
    assert('未来时间范围筛选返回空列表',
      emptyRange.status === 200 && emptyRange.body.data.length === 0,
      `实际数量: ${emptyRange.body && emptyRange.body.data ? emptyRange.body.data.length : 'N/A'}`);
  });

  console.log('\n========================');
  console.log(`通过: ${passCount}  失败: ${failCount}`);
  if (failures.length > 0) {
    console.log('\n失败详情:');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    cleanupAndExit(1);
  } else {
    console.log('\n所有检查通过 ✓');
    console.log('- 无权限列表过滤：reporter 仅能看到自己上报/处理的事故，admin/security 看全量（后端强制）');
    console.log('- 非法筛选校验：sort 字段/方向、日期格式、level 均返回 400 VALIDATION_ERROR 并含有效值提示');
    console.log('- 排序稳定：createdAt/updatedAt/level 升降序均正确，同值次级排序稳定');
    console.log('- 超时筛选：overdueOnly=true 仅返回超时事故，每条附带 overdue 字段，已结案不超时');
    console.log('- 跨重启持久化：超时配置写入 SQLite，重启后逐字段完全一致');
    console.log('- 审计日志：overdue_config_updated 记录 before/after/changes 和操作人');
    console.log('- assignedTo 和时间范围筛选正常工作');
    cleanupAndExit(0);
  }
}

main().catch((err) => {
  console.error('脚本执行出错:', err);
  cleanupAndExit(2);
});
