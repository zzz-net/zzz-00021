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
      return reject(new Error('端口 3000 已被占用，请先停止占用该端口的进程。验证脚本需要自己管理服务生命周期。'));
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

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

async function getOrCreateIncidentWithEvidence() {
  const incidentsResp = await request('GET', '/incidents', { userId: ADMIN });
  const incidents = incidentsResp.body && incidentsResp.body.data ? incidentsResp.body.data : [];

  for (const inc of incidents) {
    const detailResp = await request('GET', `/incidents/${inc.id}`, { userId: ADMIN });
    const detail = detailResp.body && detailResp.body.data;
    if (detail && detail.evidences && detail.evidences.length >= 1) {
      return detail;
    }
  }

  const createResp = await request('POST', '/incidents', {
    userId: REPORTER,
    body: {
      title: '导入验证测试事故-' + Date.now(),
      description: '用于验证导入功能的测试事故',
      location: '导入测试区',
      level: 'medium',
      occurredAt: new Date().toISOString()
    }
  });
  const newIncident = createResp.body.data;

  await request('POST', `/incidents/${newIncident.id}/start-evidence`, { userId: REPORTER });

  await request('POST', `/incidents/${newIncident.id}/evidences`, {
    userId: REPORTER,
    body: {
      type: 'photo',
      description: '导入测试证据',
      collectedAt: new Date().toISOString(),
      fileHash: `sha256:import-test-${Date.now()}`
    }
  });

  const detailResp = await request('GET', `/incidents/${newIncident.id}`, { userId: ADMIN });
  return detailResp.body.data;
}

async function main() {
  console.log('导入功能可复现验证脚本（完整版）');
  console.log('==================================');
  console.log(`服务入口: ${SERVER_ENTRY}`);
  console.log('');

  try {
    await startServer();
  } catch (err) {
    console.error('启动服务失败:', err.message);
    process.exit(2);
  }
  console.log('服务已启动 ✓');

  const defaultExportDir = path.join(__dirname, '..', 'data', 'exports');
  await request('PUT', '/export/config', {
    userId: ADMIN,
    body: {
      filenamePrefix: 'duty-export',
      exportDir: defaultExportDir,
      conflictStrategy: 'suffix'
    }
  });
  console.log('已重置导出配置为默认值 ✓');

  const testIncident = await getOrCreateIncidentWithEvidence();
  const testIncidentId = testIncident.id;
  console.log(`使用测试事故 ID: ${testIncidentId} (证据数: ${testIncident.evidences.length})`);

  const archiveResp = await request('POST', `/export/incident-archive/${testIncidentId}`, {
    userId: ADMIN,
    body: { format: 'json', download: true }
  });
  const baseArchive = archiveResp.body;
  console.log(`已获取基准归档，exportId=${baseArchive.manifest.exportId}`);

  // ========= Section 1: 配置持久化（跨重启） =========
  await section('1. 配置持久化（跨重启）：改配置 → 停服务 → 启服务 → 读配置 → 逐字段断言', async () => {
    const uniquePrefix = 'verify-import-config-' + Date.now();
    const uniqueDir = path.join(__dirname, '..', 'data', 'verify-import-config-persist');
    if (!fs.existsSync(uniqueDir)) fs.mkdirSync(uniqueDir, { recursive: true });

    console.log('  [步骤 1/5] 设置自定义 exportDir 与 filenamePrefix...');
    const putResp = await request('PUT', '/export/config', {
      userId: ADMIN,
      body: {
        filenamePrefix: uniquePrefix,
        exportDir: uniqueDir,
        conflictStrategy: 'error'
      }
    });
    assert('PUT /export/config 成功 200', putResp.status === 200, `实际=${putResp.status}`);

    const expectedConfig = {
      filenamePrefix: uniquePrefix,
      exportDir: path.resolve(uniqueDir),
      conflictStrategy: 'error'
    };

    const preGet = await request('GET', '/export/config', { userId: ADMIN });
    assertDeepEqual('重启前配置与设置值完全一致', preGet.body.data, expectedConfig);

    console.log('  [步骤 2/5] 停止服务...');
    await stopServer();
    await new Promise(r => setTimeout(r, 1000));
    const portAfterStop = await checkPortInUse(3000);
    assert('服务已停止（端口 3000 释放）', portAfterStop === false);

    console.log('  [步骤 3/5] 重新启动服务...');
    try {
      await startServer();
    } catch (err) {
      assert('服务重启成功', false, err.message);
      return;
    }
    assert('服务重启成功', true);

    console.log('  [步骤 4/5] 重启后读取配置并逐字段断言...');
    const postGet = await request('GET', '/export/config', { userId: ADMIN });
    assert('重启后 GET /export/config 成功 200', postGet.status === 200);
    assertDeepEqual('重启后配置与重启前完全一致（持久化生效）', postGet.body.data, expectedConfig);

    console.log('  [步骤 5/5] 恢复默认配置...');
    await request('PUT', '/export/config', {
      userId: ADMIN,
      body: {
        filenamePrefix: 'duty-export',
        exportDir: defaultExportDir,
        conflictStrategy: 'suffix'
      }
    });
  });

  // ========= Section 2: 无权限测试 =========
  await section('2. 无权限测试（reporter 调用所有导入相关接口均 403）', async () => {
    const r1 = await request('POST', '/export/incident-archive/import', {
      userId: REPORTER,
      body: { mode: 'dryRun', conflictStrategy: 'skip', archive: baseArchive }
    });
    assert('POST /import (archive body) 返回 403', r1.status === 403, `实际状态: ${r1.status}`);
    assert('错误码为 PERMISSION_DENIED',
      r1.body && r1.body.error && r1.body.error.code === 'PERMISSION_DENIED');

    const r2 = await request('POST', '/export/incident-archive/import-from-file', {
      userId: REPORTER,
      body: { mode: 'dryRun', filename: 'test.json' }
    });
    assert('POST /import-from-file 返回 403', r2.status === 403, `实际状态: ${r2.status}`);
    assert('错误码为 PERMISSION_DENIED',
      r2.body && r2.body.error && r2.body.error.code === 'PERMISSION_DENIED');

    const r3 = await request('GET', '/export/archives', { userId: REPORTER });
    assert('GET /export/archives 返回 403', r3.status === 403, `实际状态: ${r3.status}`);
    assert('错误码为 PERMISSION_DENIED',
      r3.body && r3.body.error && r3.body.error.code === 'PERMISSION_DENIED');

    const failedLogs = await request('GET', '/export/audit-logs', {
      userId: ADMIN, query: { action: 'data_import_failed', userId: REPORTER, format: 'json' }
    });
    const logArr = Array.isArray(failedLogs.body) ? failedLogs.body : [];
    assert('权限拒绝已写入 data_import_failed 审计日志',
      logArr.length >= 2, `找到 ${logArr.length} 条失败日志（期望至少 2 条）`);
  });

  // ========= Section 3: 目录边界与安全校验 =========
  await section('3. 目录边界与安全校验（路径穿越/同名前缀/目录/缺文件/JSON损坏）', async () => {
    const testDir = path.join(__dirname, '..', 'data', 'verify-import-restart');
    const evilDir = path.join(__dirname, '..', 'data', 'verify-import-restart-evil');
    if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
    if (!fs.existsSync(evilDir)) fs.mkdirSync(evilDir, { recursive: true });

    await request('PUT', '/export/config', {
      userId: ADMIN,
      body: { exportDir: testDir, filenamePrefix: 'sec-test', conflictStrategy: 'suffix' }
    });

    const freshIncident = await getOrCreateIncidentWithEvidence();
    const fileExportResp = await request('POST', `/export/incident-archive/${freshIncident.id}`, {
      userId: ADMIN, body: { format: 'json' }
    });
    const exportedFilename = fileExportResp.body.data.finalName;
    const exportedFilePath = fileExportResp.body.data.savedPath;

    const evilFilePath = path.join(evilDir, exportedFilename);
    try { fs.copyFileSync(exportedFilePath, evilFilePath); } catch {}

    const badPath1 = '../../etc/passwd';
    const r1 = await request('POST', '/export/incident-archive/import-from-file', {
      userId: ADMIN, body: { mode: 'dryRun', conflictStrategy: 'skip', filename: badPath1 }
    });
    assert('路径穿越 (../../etc/passwd) 被拒绝（400）',
      r1.status === 400, `实际=${r1.status} body=${JSON.stringify(r1.body)}`);
    assert('错误码为 IMPORT_VALIDATION_ERROR',
      r1.body && r1.body.error && r1.body.error.code === 'IMPORT_VALIDATION_ERROR');
    const r1Reason = r1.body && r1.body.error && r1.body.error.details && r1.body.error.details.reason;
    assert('错误响应 details.reason 说明路径越界',
      typeof r1Reason === 'string' && r1Reason.length > 0,
      `reason=${JSON.stringify(r1Reason)}`);

    const badPath2 = path.resolve(testDir, '..', 'verify-import-restart-evil', exportedFilename);
    const r2 = await request('POST', '/export/incident-archive/import-from-file', {
      userId: ADMIN, body: { mode: 'dryRun', conflictStrategy: 'skip', filename: badPath2 }
    });
    assert('同名前缀兄弟目录文件（exports-evil/）被拒绝（400）',
      r2.status === 400, `实际=${r2.status} body=${JSON.stringify(r2.body)}`);
    assert('错误码为 IMPORT_VALIDATION_ERROR',
      r2.body && r2.body.error && r2.body.error.code === 'IMPORT_VALIDATION_ERROR');
    const r2Reason = r2.body && r2.body.error && r2.body.error.details && r2.body.error.details.reason;
    assert('错误响应 details.reason 说明路径越界',
      typeof r2Reason === 'string' && r2Reason.length > 0,
      `reason=${JSON.stringify(r2Reason)}`);

    const r3 = await request('POST', '/export/incident-archive/import-from-file', {
      userId: ADMIN, body: { mode: 'dryRun', conflictStrategy: 'skip', filename: testDir }
    });
    assert('目录本身作为 filename 被拒绝（400）',
      r3.status === 400, `实际=${r3.status} body=${JSON.stringify(r3.body)}`);
    assert('错误码为 IMPORT_VALIDATION_ERROR',
      r3.body && r3.body.error && r3.body.error.code === 'IMPORT_VALIDATION_ERROR');

    const r4 = await request('POST', '/export/incident-archive/import-from-file', {
      userId: ADMIN, body: { mode: 'dryRun', conflictStrategy: 'skip', filename: 'not-exist-file-12345.json' }
    });
    assert('不存在的文件返回 404 NOT_FOUND',
      r4.status === 404, `实际=${r4.status} body=${JSON.stringify(r4.body)}`);
    assert('错误码为 NOT_FOUND',
      r4.body && r4.body.error && r4.body.error.code === 'NOT_FOUND');

    const brokenFile = path.join(testDir, 'broken.json');
    fs.writeFileSync(brokenFile, '{ this is not valid json', 'utf-8');
    const r5 = await request('POST', '/export/incident-archive/import-from-file', {
      userId: ADMIN, body: { mode: 'dryRun', conflictStrategy: 'skip', filename: 'broken.json' }
    });
    assert('损坏的 JSON 文件返回 400',
      r5.status === 400, `实际=${r5.status} body=${JSON.stringify(r5.body)}`);
    assert('错误码为 IMPORT_VALIDATION_ERROR',
      r5.body && r5.body.error && r5.body.error.code === 'IMPORT_VALIDATION_ERROR');
    const r5Reason = r5.body && r5.body.error && r5.body.error.details && r5.body.error.details.reason;
    assert('错误响应 details.reason 说明 JSON 无效',
      typeof r5Reason === 'string' && r5Reason.length > 0,
      `reason=${JSON.stringify(r5Reason)}`);

    const failedLogs2 = await request('GET', '/export/audit-logs', {
      userId: ADMIN, query: { action: 'data_import_failed', format: 'json' }
    });
    const failedLogs3 = await request('GET', '/export/audit-logs', {
      userId: ADMIN, query: { action: 'data_import_validation_failed', format: 'json' }
    });
    const arr2 = Array.isArray(failedLogs2.body) ? failedLogs2.body : [];
    const arr3 = Array.isArray(failedLogs3.body) ? failedLogs3.body : [];
    assert('路径越界/目录/缺文件失败已写入 data_import_failed 审计日志',
      arr2.length >= 3, `找到 ${arr2.length} 条 data_import_failed（期望至少 3 条）`);
    assert('JSON 损坏失败已写入 data_import_validation_failed 审计日志',
      arr3.length >= 1, `找到 ${arr3.length} 条 data_import_validation_failed（期望至少 1 条）`);

    await request('PUT', '/export/config', {
      userId: ADMIN,
      body: { exportDir: defaultExportDir, filenamePrefix: 'duty-export', conflictStrategy: 'suffix' }
    });
  });

  // ========= Section 4: 缺文件/内容校验失败 =========
  await section('4. 缺文件 / JSON 损坏 / schemaVersion 非法 — 错误响应原因可看懂 + 审计日志', async () => {
    for (const missingFile of ['manifest.json', 'incident.json', 'evidences.json', 'audit_logs.json']) {
      const badArchive = deepClone(baseArchive);
      delete badArchive.files[missingFile];

      const r = await request('POST', '/export/incident-archive/import', {
        userId: ADMIN, body: { mode: 'dryRun', conflictStrategy: 'skip', archive: badArchive }
      });
      assert(`缺 ${missingFile} 返回 400`, r.status === 400, `缺 ${missingFile} 实际 ${r.status}`);
      assert(`缺 ${missingFile} 错误码 IMPORT_VALIDATION_ERROR`,
        r.body && r.body.error && r.body.error.code === 'IMPORT_VALIDATION_ERROR');
      const detailStr = JSON.stringify(r.body && r.body.error && r.body.error.details);
      assert(`错误响应包含 ${missingFile} 相关描述`,
        detailStr.includes(missingFile) || detailStr.includes('缺少文件'),
        `details=${detailStr}`);
    }

    const badArchive2 = deepClone(baseArchive);
    badArchive2.files['incident.json'] = '{ not valid json';
    const r2 = await request('POST', '/export/incident-archive/import', {
      userId: ADMIN, body: { mode: 'dryRun', conflictStrategy: 'skip', archive: badArchive2 }
    });
    assert('incident.json 非法 JSON 返回 400', r2.status === 400);
    assert('错误码 IMPORT_VALIDATION_ERROR',
      r2.body && r2.body.error && r2.body.error.code === 'IMPORT_VALIDATION_ERROR');

    const badArchive3 = deepClone(baseArchive);
    badArchive3.manifest.schemaVersion = '99.0';
    const r3 = await request('POST', '/export/incident-archive/import', {
      userId: ADMIN, body: { mode: 'dryRun', conflictStrategy: 'skip', archive: badArchive3 }
    });
    assert('schemaVersion 不支持返回 400', r3.status === 400);

    const valLogs = await request('GET', '/export/audit-logs', {
      userId: ADMIN, query: { action: 'data_import_validation_failed', format: 'json' }
    });
    const valArr = Array.isArray(valLogs.body) ? valLogs.body : [];
    assert('校验失败已写入 data_import_validation_failed 审计日志',
      valArr.length >= 6, `找到 ${valArr.length} 条（期望至少 6 条）`);
  });

  // ========= Section 5: 冲突策略 =========
  let newIdImportedIncidentId = null;

  await section('5. 冲突策略：skip — 已存在事故 ID 时跳过不写入', async () => {
    const dryRun = await request('POST', '/export/incident-archive/import', {
      userId: ADMIN, body: { mode: 'dryRun', conflictStrategy: 'skip', archive: baseArchive }
    });
    assert('dryRun skip 策略成功 200', dryRun.status === 200);
    assert('dryRun 返回 valid=true', dryRun.body.data.valid === true);
    assert('dryRun diff.conflict.exists=true',
      dryRun.body.data.diff && dryRun.body.data.diff.conflict && dryRun.body.data.diff.conflict.exists === true);
    assert('dryRun plan.skipped=true',
      dryRun.body.data.diff && dryRun.body.data.diff.plan && dryRun.body.data.diff.plan.skipped === true);
    assert('dryRun readyForCommit=false（因为跳过）', dryRun.body.data.readyForCommit === false);

    const preList = await request('GET', '/incidents', { userId: ADMIN });
    const preCount = preList.body.data.length;

    const commit = await request('POST', '/export/incident-archive/import', {
      userId: ADMIN, body: { mode: 'commit', conflictStrategy: 'skip', archive: baseArchive }
    });
    assert('commit skip 返回 200', commit.status === 200);
    assert('commit 返回 skipped=true', commit.body.data.skipped === true,
      `实际 data=${JSON.stringify(commit.body.data)}`);

    const postList = await request('GET', '/incidents', { userId: ADMIN });
    const postCount = postList.body.data.length;
    assert('skip 策略不新增事故记录', postCount === preCount, `pre=${preCount} post=${postCount}`);
  });

  await section('6. 冲突策略：newId — 已存在 ID 时生成新 ID 并修正所有关联', async () => {
    const dryRun = await request('POST', '/export/incident-archive/import', {
      userId: ADMIN, body: { mode: 'dryRun', conflictStrategy: 'newId', archive: baseArchive }
    });
    assert('dryRun newId 成功 200', dryRun.status === 200);
    assert('dryRun valid=true', dryRun.body.data.valid === true);
    assert('dryRun diff.conflict.exists=true', dryRun.body.data.diff.conflict.exists === true);
    assert('dryRun plan.newIncidentId 非空且不等于原 ID',
      dryRun.body.data.diff.plan.newIncidentId
      && dryRun.body.data.diff.plan.newIncidentId !== dryRun.body.data.diff.plan.oldIncidentId);
    assert('dryRun plan.remapped=true', dryRun.body.data.diff.plan.remapped === true);
    assert('dryRun readyForCommit=true', dryRun.body.data.readyForCommit === true);

    const preList = await request('GET', '/incidents', { userId: ADMIN });
    const preCount = preList.body.data.length;

    const commit = await request('POST', '/export/incident-archive/import', {
      userId: ADMIN, body: { mode: 'commit', conflictStrategy: 'newId', archive: baseArchive }
    });
    assert('commit newId 返回 200', commit.status === 200);
    assert('commit 返回 imported=true', commit.body.data.imported === true);
    assert('commit newIncidentId 非空', !!commit.body.data.newIncidentId);
    assert('commit newIncidentId 不等于原 ID',
      commit.body.data.newIncidentId !== testIncidentId);

    newIdImportedIncidentId = commit.body.data.newIncidentId;

    const postList = await request('GET', '/incidents', { userId: ADMIN });
    const postCount = postList.body.data.length;
    assert('newId 策略新增 1 条事故记录', postCount === preCount + 1,
      `pre=${preCount} post=${postCount}`);

    const importedDetail = await request('GET', `/incidents/${newIdImportedIncidentId}`, { userId: ADMIN });
    assert('通过新 ID 能查询到导入的事故', importedDetail.status === 200,
      `查询状态=${importedDetail.status}`);
    assert('导入事故 title 与源事故一致',
      importedDetail.body.data.title === testIncident.title);
    assert('导入事故证据数量与源事故一致',
      importedDetail.body.data.evidences.length === testIncident.evidences.length,
      `源=${testIncident.evidences.length} 导入=${importedDetail.body.data.evidences.length}`);
    assert('导入证据的 incidentId 已修正为新 ID',
      importedDetail.body.data.evidences.every(e => e.incidentId === newIdImportedIncidentId),
      `存在 evidence.incidentId != ${newIdImportedIncidentId}`);

    const importedAuditLogs = await request('GET', `/incidents/${newIdImportedIncidentId}/audit-logs`, {
      userId: ADMIN
    });
    const logs = importedAuditLogs.body && importedAuditLogs.body.data ? importedAuditLogs.body.data : [];
    assert('导入事故有相关审计日志',
      logs.length > 0, `找到 ${logs.length} 条审计日志`);
    assert('审计日志中的 incidentId 已全部修正为新 ID',
      logs.every(l => l.incidentId === newIdImportedIncidentId),
      `存在 log.incidentId != ${newIdImportedIncidentId}`);

    const successLogs = await request('GET', '/export/audit-logs', {
      userId: ADMIN, query: { action: 'data_imported', format: 'json' }
    });
    const successArr = Array.isArray(successLogs.body) ? successLogs.body : [];
    assert('导入成功已写入 data_imported 审计日志',
      successArr.length > 0, `找到 ${successArr.length} 条`);
  });

  // ========= Section 7: 导入后再导出一致性 =========
  await section('7. 导入后再导出 — 事故核心字段 + 证据属性深度对比', async () => {
    if (!newIdImportedIncidentId) {
      console.log('  跳过（前一步未导入事故）');
      return;
    }

    const reExportResp = await request('POST', `/export/incident-archive/${newIdImportedIncidentId}`, {
      userId: ADMIN, body: { format: 'json', download: true }
    });
    assert('重新导出成功 200', reExportResp.status === 200);

    const reExportedIncident = JSON.parse(reExportResp.body.files['incident.json']);
    const sourceIncident = JSON.parse(baseArchive.files['incident.json']);

    const coreFields = ['title', 'description', 'location', 'level', 'status', 'occurredAt',
      'reporterId', 'reporterName', 'returnReason'];
    for (const f of coreFields) {
      assert(`重新导出 incident.${f} 与源事故一致`,
        reExportedIncident[f] === sourceIncident[f],
        `${f}: 源=${JSON.stringify(sourceIncident[f])} 重导=${JSON.stringify(reExportedIncident[f])}`);
    }

    const reExportedEvidences = JSON.parse(reExportResp.body.files['evidences.json']);
    const sourceEvidences = JSON.parse(baseArchive.files['evidences.json']);
    assert('重新导出证据数量与源一致',
      reExportedEvidences.length === sourceEvidences.length,
      `源=${sourceEvidences.length} 重导=${reExportedEvidences.length}`);

    for (let i = 0; i < Math.min(reExportedEvidences.length, sourceEvidences.length); i++) {
      const src = sourceEvidences[i];
      const re = reExportedEvidences[i];
      assert(`evidence[${i}] type/description/collectedAt/collectorId/collectorName/fileHash/filePath 一致`,
        re.type === src.type
        && re.description === src.description
        && re.collectedAt === src.collectedAt
        && re.collectorId === src.collectorId
        && re.collectorName === src.collectorName
        && re.fileHash === src.fileHash
        && re.filePath === src.filePath,
        `src=${JSON.stringify({ type: src.type, description: src.description, collectedAt: src.collectedAt, collectorName: src.collectorName, fileHash: src.fileHash })} re=${JSON.stringify({ type: re.type, description: re.description, collectedAt: re.collectedAt, collectorName: re.collectorName, fileHash: re.fileHash })}`);
    }

    const reManifest = reExportResp.body.manifest;
    assert('重新导出 manifest.dataFormat = json', reManifest.dataFormat === 'json');
    assert('重新导出 manifest.counts.incidents = 1', reManifest.counts.incidents === 1);
    assert('重新导出 manifest.counts.evidences 与源一致',
      reManifest.counts.evidences === sourceEvidences.length);
    assert('重新导出 manifest.incidentId = 新 ID',
      reManifest.incidentId === newIdImportedIncidentId);
  });

  // ========= Section 8: 服务重启后按配置目录读取归档 + GET /export/archives =========
  await section('8. 服务重启后按最新配置目录读取归档 + GET /export/archives 元数据校验', async () => {
    const uniquePrefix = 'verify-import-restart-' + Date.now();
    const uniqueDir = path.join(__dirname, '..', 'data', 'verify-import-restart-full');
    if (!fs.existsSync(uniqueDir)) fs.mkdirSync(uniqueDir, { recursive: true });

    console.log('  [步骤 1/8] 设置自定义 exportDir 并导出一个新归档...');
    await request('PUT', '/export/config', {
      userId: ADMIN,
      body: { filenamePrefix: uniquePrefix, exportDir: uniqueDir, conflictStrategy: 'suffix' }
    });

    const freshIncidentResp = await request('POST', '/incidents', {
      userId: REPORTER,
      body: {
        title: '完整跨重启导入测试事故-' + Date.now(),
        description: '测试服务重启后从配置目录读取并导入',
        location: '完整重启测试区',
        level: 'low',
        occurredAt: new Date().toISOString()
      }
    });
    const freshIncidentId = freshIncidentResp.body.data.id;

    await request('POST', `/incidents/${freshIncidentId}/start-evidence`, { userId: REPORTER });
    await request('POST', `/incidents/${freshIncidentId}/evidences`, {
      userId: REPORTER,
      body: {
        type: 'document',
        description: '完整重启测试证据',
        collectedAt: new Date().toISOString(),
        fileHash: `sha256:full-restart-test-${Date.now()}`
      }
    });

    const fileExportResp = await request('POST', `/export/incident-archive/${freshIncidentId}`, {
      userId: ADMIN, body: { format: 'json' }
    });
    assert('导出到自定义目录成功', fileExportResp.status === 200);
    const exportedFilename = fileExportResp.body.data.finalName;
    const exportedFilePath = fileExportResp.body.data.savedPath;
    assert('导出文件名含自定义前缀', exportedFilename.startsWith(uniquePrefix));
    assert('导出文件在自定义目录内',
      path.resolve(exportedFilePath).startsWith(path.resolve(uniqueDir)));
    assert('导出文件确实存在于磁盘', fs.existsSync(exportedFilePath));

    const expectedConfig = {
      filenamePrefix: uniquePrefix,
      exportDir: path.resolve(uniqueDir),
      conflictStrategy: 'suffix'
    };

    console.log('  [步骤 2/8] 停止服务...');
    await stopServer();
    await new Promise(r => setTimeout(r, 1000));
    const portAfterStop = await checkPortInUse(3000);
    assert('服务已停止（端口 3000 释放）', portAfterStop === false);

    console.log('  [步骤 3/8] 重新启动服务...');
    try {
      await startServer();
    } catch (err) {
      assert('服务重启成功', false, err.message);
      return;
    }
    assert('服务重启成功', true);

    console.log('  [步骤 4/8] 验证 exportDir 配置在重启后仍然生效...');
    const configAfterRestart = await request('GET', '/export/config', { userId: ADMIN });
    assert('重启后 GET /export/config 成功 200', configAfterRestart.status === 200);
    assertDeepEqual('重启后配置与重启前一致（持久化生效）',
      configAfterRestart.body.data, expectedConfig);

    console.log('  [步骤 5/8] GET /export/archives 列出可导入归档...');
    const archivesResp = await request('GET', '/export/archives', { userId: ADMIN });
    assert('GET /export/archives 成功 200', archivesResp.status === 200);
    assert('响应含 exportDir 字段',
      archivesResp.body.exportDir === path.resolve(uniqueDir),
      `exportDir=${archivesResp.body.exportDir}`);
    assert('响应 data 为数组', Array.isArray(archivesResp.body.data));
    const archives = archivesResp.body.data;
    assert('列表至少含 1 个归档', archives.length >= 1, `找到 ${archives.length} 个`);

    const targetArchive = archives.find(a => a.filename === exportedFilename);
    assert('刚导出的归档在列表中可找到', !!targetArchive,
      `期望 filename=${exportedFilename}，实际列表=${archives.map(a => a.filename).join(', ')}`);
    if (targetArchive) {
      assert('条目含 filename', typeof targetArchive.filename === 'string' && targetArchive.filename.length > 0);
      assert('条目含 filePath', typeof targetArchive.filePath === 'string' && targetArchive.filePath.length > 0);
      assert('条目含 size', typeof targetArchive.size === 'number' && targetArchive.size > 0);
      assert('条目含 mtime', typeof targetArchive.mtime === 'string' && targetArchive.mtime.length > 0);
      assert('条目含 exportDir', targetArchive.exportDir === path.resolve(uniqueDir));
      assert('条目含 manifest.exportId', !!targetArchive.manifest && !!targetArchive.manifest.exportId);
      assert('条目含 manifest.incidentId',
        !!targetArchive.manifest && targetArchive.manifest.incidentId === freshIncidentId);
      assert('条目含 manifest.counts',
        !!targetArchive.manifest && !!targetArchive.manifest.counts);
    }

    console.log('  [步骤 6/8] dryRun 预览（使用 filename 相对路径）...');
    const dryRunFile = await request('POST', '/export/incident-archive/import-from-file', {
      userId: ADMIN,
      body: { mode: 'dryRun', conflictStrategy: 'skip', filename: exportedFilename }
    });
    assert('import-from-file dryRun（相对路径）成功 200', dryRunFile.status === 200,
      `实际=${dryRunFile.status} body=${JSON.stringify(dryRunFile.body)}`);
    assert('dryRun valid=true', dryRunFile.body.data.valid === true);

    console.log('  [步骤 7/8] dryRun 预览（使用绝对路径，位于 exportDir 内）...');
    const dryRunAbs = await request('POST', '/export/incident-archive/import-from-file', {
      userId: ADMIN,
      body: { mode: 'dryRun', conflictStrategy: 'skip', filename: exportedFilePath }
    });
    assert('import-from-file dryRun（绝对路径）成功 200', dryRunAbs.status === 200,
      `实际=${dryRunAbs.status} body=${JSON.stringify(dryRunAbs.body)}`);
    assert('dryRun valid=true', dryRunAbs.body.data.valid === true);

    console.log('  [步骤 8/8] commit 真正导入...');
    const commitFile = await request('POST', '/export/incident-archive/import-from-file', {
      userId: ADMIN,
      body: { mode: 'commit', conflictStrategy: 'newId', filename: exportedFilename }
    });
    assert('import-from-file commit 成功 200', commitFile.status === 200,
      `实际=${commitFile.status} body=${JSON.stringify(commitFile.body)}`);
    assert('commit 返回 imported=true', commitFile.body.data.imported === true);
    assert('commit 生成了新的 incidentId',
      !!commitFile.body.data.newIncidentId
      && commitFile.body.data.newIncidentId !== freshIncidentId);
    assert('commit 返回 sourceFile 信息',
      !!commitFile.body.data.sourceFile
      && commitFile.body.data.sourceFile.filename === exportedFilename,
      `sourceFile=${JSON.stringify(commitFile.body.data.sourceFile)}`);

    const importedId = commitFile.body.data.newIncidentId;
    const verifyResp = await request('GET', `/incidents/${importedId}`, { userId: ADMIN });
    assert('重启后导入的事故可通过新 ID 查询到', verifyResp.status === 200);
    assert('导入的事故标题与源事故一致',
      verifyResp.body.data.title === freshIncidentResp.body.data.title);

    await request('PUT', '/export/config', {
      userId: ADMIN,
      body: { exportDir: defaultExportDir, filenamePrefix: 'duty-export', conflictStrategy: 'suffix' }
    });
    console.log('  已恢复默认导出配置 ✓');
  });

  // ========= Summary =========
  console.log('\n========================');
  console.log(`通过: ${passCount}  失败: ${failCount}`);
  if (failures.length > 0) {
    console.log('\n失败详情:');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    cleanupAndExit(1);
  } else {
    console.log('\n所有检查通过 ✓');
    console.log('- 配置跨重启持久化（逐字段深度断言）');
    console.log('- reporter 无权限访问 import、import-from-file、archives 三个接口');
    console.log('- 目录边界校验：路径穿越、同名前缀兄弟目录、目录本身、缺文件、损坏 JSON 全部正确拒绝并写审计');
    console.log('- 缺文件/JSON 非法/schemaVersion 非法均返回 IMPORT_VALIDATION_ERROR，原因可看懂');
    console.log('- skip 冲突策略：已存在 ID 时跳过，不新增记录');
    console.log('- newId 冲突策略：生成新 UUID，证据 incidentId、审计日志 incidentId 全部修正');
    console.log('- 导入后再导出：事故核心字段 + 证据属性深度一致，manifest 计数和 incidentId 正确');
    console.log('- 服务重启后配置持久化保留，GET /export/archives 返回完整元数据，import-from-file 支持相对/绝对路径');
    cleanupAndExit(0);
  }
}

main().catch((err) => {
  console.error('脚本执行出错:', err);
  cleanupAndExit(2);
});
