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
  console.log('导出功能可复现验证脚本');
  console.log('========================');
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

  const incidentsResp = await request('GET', '/incidents', { userId: ADMIN });
  const incidents = incidentsResp.body && incidentsResp.body.data ? incidentsResp.body.data : [];
  if (incidents.length === 0) {
    console.log('未找到事故数据，创建一个测试事故...');
    const createResp = await request('POST', '/incidents', {
      userId: REPORTER,
      body: {
        title: '导出验证测试事故',
        description: '用于验证导出功能',
        location: '测试区',
        level: 'low',
        occurredAt: new Date().toISOString()
      }
    });
    incidents.push(createResp.body.data);
  }
  const testIncidentId = incidents[0].id;
  console.log(`使用测试事故 ID: ${testIncidentId}`);

  await section('1. 普通上报人（reporter）和班长（foreman）无权限导出', async () => {
    const r1 = await request('GET', '/export/incidents', { userId: REPORTER });
    assert('reporter: GET /export/incidents 返回 403', r1.status === 403, `实际状态: ${r1.status}`);
    assert('reporter: 错误码为 PERMISSION_DENIED',
      r1.body && r1.body.error && r1.body.error.code === 'PERMISSION_DENIED');
    assert('reporter: 错误 details 含 required=EXPORT_DATA',
      r1.body && r1.body.error && r1.body.error.details && r1.body.error.details.required === 'EXPORT_DATA');
    assert('reporter: 错误 details 含 userRole=reporter',
      r1.body && r1.body.error && r1.body.error.details && r1.body.error.details.userRole === 'reporter');

    const rForeman = await request('GET', '/export/incidents', { userId: 'foreman-001' });
    assert('foreman: GET /export/incidents 返回 403', rForeman.status === 403, `实际状态: ${rForeman.status}`);
    assert('foreman: 错误码为 PERMISSION_DENIED',
      rForeman.body && rForeman.body.error && rForeman.body.error.code === 'PERMISSION_DENIED');

    const r2 = await request('POST', `/export/incident-archive/${testIncidentId}`, {
      userId: REPORTER, body: { format: 'json' }
    });
    assert('reporter: POST /export/incident-archive 返回 403', r2.status === 403, `实际状态: ${r2.status}`);

    const r3 = await request('GET', '/export/config', { userId: REPORTER });
    assert('reporter: GET /export/config 返回 403', r3.status === 403, `实际状态: ${r3.status}`);

    const r4 = await request('GET', '/export/saved', { userId: REPORTER });
    assert('reporter: GET /export/saved 返回 403', r4.status === 403, `实际状态: ${r4.status}`);

    const r5 = await request('GET', '/export/evidences', { userId: REPORTER });
    assert('reporter: GET /export/evidences 返回 403', r5.status === 403, `实际状态: ${r5.status}`);

    const r6 = await request('GET', '/export/audit-logs', { userId: REPORTER });
    assert('reporter: GET /export/audit-logs 返回 403', r6.status === 403, `实际状态: ${r6.status}`);

    const globalLogs = await request('GET', '/export/audit-logs', {
      userId: ADMIN, query: { action: 'data_export_failed', userId: REPORTER, format: 'json' }
    });
    const failedLogs = Array.isArray(globalLogs.body) ? globalLogs.body : [];
    assert('失败审计日志已写入（data_export_failed）',
      failedLogs.length > 0, `找到 ${failedLogs.length} 条失败日志`);
    if (failedLogs.length > 0) {
      const lastFail = failedLogs[failedLogs.length - 1];
      assert('失败审计日志 details 含 type=permission_denied',
        lastFail.details && lastFail.details.type === 'permission_denied');
      assert('失败审计日志 details 含 requiredPermission=EXPORT_DATA',
        lastFail.details && lastFail.details.requiredPermission === 'EXPORT_DATA');
    }
  });

  let savedArchivePath = null;
  let savedArchiveName = null;

  await section('2. 单事故完整归档导出 — 内容一致性（含 exportedBy、manifest 自描述、文件计数）', async () => {
    const detailResp = await request('GET', `/incidents/${testIncidentId}`, { userId: ADMIN });
    const detail = detailResp.body.data;
    const expectedEvidenceCount = (detail.evidences || []).length;

    const archiveResp = await request('POST', `/export/incident-archive/${testIncidentId}`, {
      userId: ADMIN, body: { format: 'json' }
    });

    assert('导出请求成功 200', archiveResp.status === 200, `实际状态: ${archiveResp.status}`);
    assert('success=true', archiveResp.body && archiveResp.body.success === true);

    const data = archiveResp.body.data;
    savedArchivePath = data.savedPath;
    savedArchiveName = data.finalName;

    assert('manifest 存在', !!data.manifest);
    assert('manifest.schemaVersion = 1.0', data.manifest && data.manifest.schemaVersion === '1.0');
    assert('manifest.exportedAt 为 ISO 时间',
      data.manifest && typeof data.manifest.exportedAt === 'string' && data.manifest.exportedAt.includes('T'));
    assert('manifest.exportId 非空', data.manifest && !!data.manifest.exportId);
    assert('manifest.dataFormat = json', data.manifest && data.manifest.dataFormat === 'json');
    assert('manifest.incidentId 匹配', data.manifest && data.manifest.incidentId === testIncidentId);

    assert('manifest.exportedBy 存在且 userId = admin-001',
      data.manifest && data.manifest.exportedBy && data.manifest.exportedBy.userId === 'admin-001');
    assert('manifest.exportedBy.userName = 孙管理',
      data.manifest && data.manifest.exportedBy && data.manifest.exportedBy.userName === '孙管理');
    assert('manifest.exportedBy.userRole = admin',
      data.manifest && data.manifest.exportedBy && data.manifest.exportedBy.userRole === 'admin');

    assert('manifest.counts.incidents = 1',
      data.manifest && data.manifest.counts && data.manifest.counts.incidents === 1);
    assert(`manifest.counts.evidences = ${expectedEvidenceCount}`,
      data.manifest && data.manifest.counts && data.manifest.counts.evidences === expectedEvidenceCount,
      `实际 evidences=${data.manifest && data.manifest.counts && data.manifest.counts.evidences}`);
    assert('manifest.counts.auditLogs >= 0',
      data.manifest && data.manifest.counts && typeof data.manifest.counts.auditLogs === 'number');
    assert('manifest.counts 包含 receiptPackages',
      data.manifest && data.manifest.counts && typeof data.manifest.counts.receiptPackages === 'number');
    assert('manifest.counts 包含 receiptRecords',
      data.manifest && data.manifest.counts && typeof data.manifest.counts.receiptRecords === 'number');

    assert('manifest.files 包含 6 个文件（含签收包）',
      data.manifest && data.manifest.files && data.manifest.files.length === 6,
      `实际 ${data.manifest && data.manifest.files && data.manifest.files.length}`);
    assert('files 列表包含 manifest.json',
      data.files && data.files.includes('manifest.json'));
    assert('files 列表包含 incident.json',
      data.files && data.files.includes('incident.json'));
    assert('files 列表包含 evidences.json',
      data.files && data.files.includes('evidences.json'));
    assert('files 列表包含 audit_logs.json',
      data.files && data.files.includes('audit_logs.json'));
    assert('files 列表包含 receipt_packages.json',
      data.files && data.files.includes('receipt_packages.json'));
    assert('files 列表包含 receipt_records.json',
      data.files && data.files.includes('receipt_records.json'));
    assert('savedPath 非空', !!data.savedPath);
    assert('finalName 非空', !!data.finalName);

    const downloadResp = await request('GET', `/export/incident-archive/${testIncidentId}`, {
      userId: ADMIN, query: { download: 'true', format: 'json' }
    });
    assert('download=true 直接下载成功', downloadResp.status === 200);
    assert('下载响应含 manifest', !!downloadResp.body.manifest);
    assert('下载响应含 files', !!downloadResp.body.files);
    assert('下载 files 含 6 个条目（含签收包）', downloadResp.body.files && Object.keys(downloadResp.body.files).length === 6);
    const incidentContent = JSON.parse(downloadResp.body.files['incident.json']);
    assert('incident.json 内容 id 匹配', incidentContent.id === testIncidentId);
    const manifestContent = JSON.parse(downloadResp.body.files['manifest.json']);
    assert('manifest.json 自描述一致（exportId）', manifestContent.exportId === downloadResp.body.manifest.exportId);
    assert('manifest.json 自描述 exportedBy 一致',
      manifestContent.exportedBy && manifestContent.exportedBy.userId === downloadResp.body.manifest.exportedBy.userId);

    // 用 security 角色导出，验证 exportedBy 正确
    const secArchiveResp = await request('POST', `/export/incident-archive/${testIncidentId}`, {
      userId: SECURITY, body: { format: 'json' }
    });
    assert('security 角色导出成功', secArchiveResp.status === 200);
    assert('security 导出的 manifest.exportedBy.userId = security-001',
      secArchiveResp.body && secArchiveResp.body.data && secArchiveResp.body.data.manifest
      && secArchiveResp.body.data.manifest.exportedBy && secArchiveResp.body.data.manifest.exportedBy.userId === 'security-001');
    assert('security 导出的 manifest.exportedBy.userName = 赵安保',
      secArchiveResp.body && secArchiveResp.body.data && secArchiveResp.body.data.manifest
      && secArchiveResp.body.data.manifest.exportedBy && secArchiveResp.body.data.manifest.exportedBy.userName === '赵安保');
    assert('security 导出的 manifest.exportedBy.userRole = security',
      secArchiveResp.body && secArchiveResp.body.data && secArchiveResp.body.data.manifest
      && secArchiveResp.body.data.manifest.exportedBy && secArchiveResp.body.data.manifest.exportedBy.userRole === 'security');
  });

  await section('3. 同名冲突处理（suffix 自动后缀 + error 策略）', async () => {
    if (!savedArchivePath) {
      console.log('  跳过（前一步未生成归档）');
      return;
    }

    await request('PUT', '/export/config', {
      userId: ADMIN, body: { conflictStrategy: 'suffix' }
    });

    const resp1 = await request('POST', `/export/incident-archive/${testIncidentId}`, {
      userId: ADMIN, body: { format: 'json' }
    });
    assert('默认 suffix 策略：再次导出不报错', resp1.status === 200, `实际 ${resp1.status}`);
    if (resp1.status !== 200 || !resp1.body || !resp1.body.data) {
      console.log('  （后续同名冲突断言跳过）');
      return;
    }
    assert('自动添加后缀 renamed=true',
      resp1.body.data.renamed === true,
      `实际 renamed=${resp1.body.data.renamed}`);
    assert('最终文件名与上次不同',
      resp1.body.data.finalName !== savedArchiveName,
      `${resp1.body.data.finalName} vs ${savedArchiveName}`);

    const confResp = await request('PUT', '/export/config', {
      userId: ADMIN, body: { conflictStrategy: 'error' }
    });
    assert('切换到 error 策略成功', confResp.status === 200);

    const resp2 = await request('POST', `/export/incident-archive/${testIncidentId}`, {
      userId: ADMIN, body: { format: 'json' }
    });
    assert('error 策略：同名返回 409', resp2.status === 409, `实际 ${resp2.status}`);
    assert('错误码为 EXPORT_CONFLICT',
      resp2.body && resp2.body.error && resp2.body.error.code === 'EXPORT_CONFLICT');
    assert('details 中包含 existingPath',
      resp2.body && resp2.body.error && resp2.body.error.details && !!resp2.body.error.details.existingPath);
    assert('details 中包含 strategy=error',
      resp2.body && resp2.body.error && resp2.body.error.details && resp2.body.error.details.strategy === 'error');

    await request('PUT', '/export/config', {
      userId: ADMIN, body: { conflictStrategy: 'suffix' }
    });
  });

  await section('4. CSV 格式归档 + 已保存列表 + 审计日志（成功/失败/配置变更）', async () => {
    const uniquePrefix = 'verify-section4-' + Date.now();
    const uniqueDir = path.join(__dirname, '..', 'data', 'verify-exports-section4');

    const putResp = await request('PUT', '/export/config', {
      userId: ADMIN,
      body: {
        filenamePrefix: uniquePrefix,
        exportDir: uniqueDir,
        conflictStrategy: 'suffix'
      }
    });
    assert('PUT /export/config 成功', putResp.status === 200);
    assert('返回 filenamePrefix 匹配', putResp.body.data.filenamePrefix === uniquePrefix);
    assert('返回 exportDir 匹配（绝对路径）',
      putResp.body.data.exportDir === path.resolve(uniqueDir));

    const getResp = await request('GET', '/export/config', { userId: SECURITY });
    assert('GET /export/config 读取到相同配置', getResp.status === 200);
    assert('filenamePrefix 进程内匹配', getResp.body.data.filenamePrefix === uniquePrefix);
    assert('conflictStrategy 进程内匹配', getResp.body.data.conflictStrategy === 'suffix');

    const csvResp = await request('POST', `/export/incident-archive/${testIncidentId}`, {
      userId: ADMIN, body: { format: 'csv' }
    });
    assert('CSV 格式归档导出成功', csvResp.status === 200);
    assert('manifest.dataFormat = csv', csvResp.body.data.manifest.dataFormat === 'csv');
    assert('CSV 归档 manifest.exportedBy.userId = admin-001',
      csvResp.body.data.manifest.exportedBy && csvResp.body.data.manifest.exportedBy.userId === 'admin-001');
    assert('files 包含 incident.csv', csvResp.body.data.files.includes('incident.csv'));
    assert('files 包含 evidences.csv', csvResp.body.data.files.includes('evidences.csv'));
    assert('files 包含 audit_logs.csv', csvResp.body.data.files.includes('audit_logs.csv'));
    assert('files 包含 receipt_packages.csv', csvResp.body.data.files.includes('receipt_packages.csv'));
    assert('files 包含 receipt_records.csv', csvResp.body.data.files.includes('receipt_records.csv'));
    assert('文件名含自定义前缀', csvResp.body.data.finalName.startsWith(uniquePrefix));
    assert('文件保存在自定义目录',
      csvResp.body.data.savedPath.startsWith(path.resolve(uniqueDir)));

    const listResp = await request('GET', '/export/saved', { userId: ADMIN });
    assert('GET /export/saved 成功', listResp.status === 200);
    assert('已保存列表非空', Array.isArray(listResp.body.data) && listResp.body.data.length > 0);
    const savedItem = listResp.body.data[0];
    assert('列表条目含 filename', !!savedItem.filename);
    assert('列表条目含 fullPath', !!savedItem.fullPath);
    assert('列表条目含 manifest', !!savedItem.manifest && !!savedItem.manifest.exportId);
    assert('列表条目 manifest 含 exportedBy',
      savedItem.manifest && savedItem.manifest.exportedBy && !!savedItem.manifest.exportedBy.userId);

    const configLogsResp = await request('GET', '/export/audit-logs', {
      userId: ADMIN, query: { action: 'export_config_updated', format: 'json' }
    });
    const configLogs = Array.isArray(configLogsResp.body) ? configLogsResp.body : [];
    assert('配置更新审计日志已记录（export_config_updated）',
      configLogs.length > 0, `找到 ${configLogs.length} 条`);

    const successResp = await request('GET', '/export/audit-logs', {
      userId: ADMIN, query: { action: 'data_exported', format: 'json' }
    });
    const successLogs = Array.isArray(successResp.body) ? successResp.body : [];
    assert('成功导出审计日志已记录（data_exported）',
      successLogs.length > 0, `找到 ${successLogs.length} 条`);
  });

  let crossRestartExpected = null;

  await section('5. 配置跨重启持久化（自动：改配置 → 停服务 → 启服务 → 读配置 → 断言）', async () => {
    const uniquePrefix = 'verify-restart-' + Date.now();
    const uniqueDir = path.join(__dirname, '..', 'data', 'verify-exports-restart');

    console.log('  [步骤 1/4] 设置自定义配置...');
    const putResp = await request('PUT', '/export/config', {
      userId: ADMIN,
      body: {
        filenamePrefix: uniquePrefix,
        exportDir: uniqueDir,
        conflictStrategy: 'error'
      }
    });
    assert('设置配置成功（重启前）', putResp.status === 200);

    crossRestartExpected = {
      filenamePrefix: uniquePrefix,
      exportDir: path.resolve(uniqueDir),
      conflictStrategy: 'error'
    };

    const preGet = await request('GET', '/export/config', { userId: ADMIN });
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
    const postGet = await request('GET', '/export/config', { userId: ADMIN });
    assert('重启后 GET /export/config 成功', postGet.status === 200);

    assertDeepEqual(
      '重启后配置与重启前设置完全一致（持久化生效）',
      postGet.body.data,
      crossRestartExpected
    );

    const postGetBySecurity = await request('GET', '/export/config', { userId: SECURITY });
    assertDeepEqual(
      'security 角色读取到相同配置（权限链路验证）',
      postGetBySecurity.body.data,
      crossRestartExpected
    );
  });

  console.log('\n========================');
  console.log(`通过: ${passCount}  失败: ${failCount}`);
  if (failures.length > 0) {
    console.log('\n失败详情:');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    cleanupAndExit(1);
  } else {
    console.log('\n所有检查通过 ✓');
    console.log('- reporter/foreman 无权限导出（带失败审计，含 requiredPermission=EXPORT_DATA）');
    console.log('- 单事故 JSON/CSV 归档内容一致性 + manifest 自描述');
    console.log('- manifest.exportedBy 正确记录导出人 userId/userName/userRole（admin 和 security 双角色验证）');
    console.log('- manifest.files 完整 6 个文件（含 receipt_packages/receipt_records）');
    console.log('- 同名冲突 suffix/error 两种策略（suffix 自动重命名，error 返回 409）');
    console.log('- 成功/失败/配置变更 三类审计日志');
    console.log('- 跨重启配置持久化（自动停止+重启+逐字段断言）');
    cleanupAndExit(0);
  }
}

main().catch((err) => {
  console.error('脚本执行出错:', err);
  cleanupAndExit(2);
});
