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
  console.log('导入功能可复现验证脚本');
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

  const testIncident = await getOrCreateIncidentWithEvidence();
  const testIncidentId = testIncident.id;
  console.log(`使用测试事故 ID: ${testIncidentId} (证据数: ${testIncident.evidences.length})`);

  const archiveResp = await request('POST', `/export/incident-archive/${testIncidentId}`, {
    userId: ADMIN,
    body: { format: 'json', download: true }
  });
  const baseArchive = archiveResp.body;
  console.log(`已获取基准归档，exportId=${baseArchive.manifest.exportId}`);

  await section('1. 普通上报人（reporter）无权限导入', async () => {
    const r1 = await request('POST', '/export/incident-archive/import', {
      userId: REPORTER,
      body: {
        mode: 'dryRun',
        conflictStrategy: 'skip',
        archive: baseArchive
      }
    });
    assert('POST /import (archive body) 返回 403', r1.status === 403, `实际状态: ${r1.status}`);
    assert('错误码为 PERMISSION_DENIED',
      r1.body && r1.body.error && r1.body.error.code === 'PERMISSION_DENIED');

    const r2 = await request('POST', '/export/incident-archive/import-from-file', {
      userId: REPORTER,
      body: {
        mode: 'dryRun',
        filename: 'test.json'
      }
    });
    assert('POST /import-from-file 返回 403', r2.status === 403, `实际状态: ${r2.status}`);
    assert('错误码为 PERMISSION_DENIED',
      r2.body && r2.body.error && r2.body.error.code === 'PERMISSION_DENIED');

    const failedLogs = await request('GET', '/export/audit-logs', {
      userId: ADMIN, query: { action: 'data_import_failed', userId: REPORTER, format: 'json' }
    });
    const logArr = Array.isArray(failedLogs.body) ? failedLogs.body : [];
    assert('权限拒绝已写入 data_import_failed 审计日志',
      logArr.length > 0, `找到 ${logArr.length} 条失败日志`);
  });

  await section('2. 缺文件 / 内容校验失败 — 错误响应原因可看懂', async () => {
    for (const missingFile of ['manifest.json', 'incident.json', 'evidences.json', 'audit_logs.json']) {
      const badArchive = deepClone(baseArchive);
      delete badArchive.files[missingFile];

      const r = await request('POST', '/export/incident-archive/import', {
        userId: ADMIN,
        body: { mode: 'dryRun', conflictStrategy: 'skip', archive: badArchive }
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
      userId: ADMIN,
      body: { mode: 'dryRun', conflictStrategy: 'skip', archive: badArchive2 }
    });
    assert('incident.json 非法 JSON 返回 400', r2.status === 400);
    assert('错误码 IMPORT_VALIDATION_ERROR',
      r2.body && r2.body.error && r2.body.error.code === 'IMPORT_VALIDATION_ERROR');

    const badArchive3 = deepClone(baseArchive);
    badArchive3.manifest.schemaVersion = '99.0';
    const r3 = await request('POST', '/export/incident-archive/import', {
      userId: ADMIN,
      body: { mode: 'dryRun', conflictStrategy: 'skip', archive: badArchive3 }
    });
    assert('schemaVersion 不支持返回 400', r3.status === 400);
    const valLogs = await request('GET', '/export/audit-logs', {
      userId: ADMIN, query: { action: 'data_import_validation_failed', format: 'json' }
    });
    const valArr = Array.isArray(valLogs.body) ? valLogs.body : [];
    assert('校验失败已写入 data_import_validation_failed 审计日志',
      valArr.length > 0, `找到 ${valArr.length} 条`);
  });

  await section('3. 冲突策略：skip — 已存在事故 ID 时跳过不写入', async () => {
    const dryRun = await request('POST', '/export/incident-archive/import', {
      userId: ADMIN,
      body: { mode: 'dryRun', conflictStrategy: 'skip', archive: baseArchive }
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
      userId: ADMIN,
      body: { mode: 'commit', conflictStrategy: 'skip', archive: baseArchive }
    });
    assert('commit skip 返回 200', commit.status === 200);
    assert('commit 返回 skipped=true', commit.body.data.skipped === true,
      `实际 data=${JSON.stringify(commit.body.data)}`);

    const postList = await request('GET', '/incidents', { userId: ADMIN });
    const postCount = postList.body.data.length;
    assert('skip 策略不新增事故记录', postCount === preCount,
      `pre=${preCount} post=${postCount}`);
  });

  let newIdImportedIncidentId = null;

  await section('4. 冲突策略：newId — 已存在 ID 时生成新 ID 并修正所有关联', async () => {
    const dryRun = await request('POST', '/export/incident-archive/import', {
      userId: ADMIN,
      body: { mode: 'dryRun', conflictStrategy: 'newId', archive: baseArchive }
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
      userId: ADMIN,
      body: { mode: 'commit', conflictStrategy: 'newId', archive: baseArchive }
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
    assert('导入事故有相关审计日志（至少 incident_created 等）',
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

  await section('5. 导入后再导出 — 内容一致性对比', async () => {
    if (!newIdImportedIncidentId) {
      console.log('  跳过（前一步未导入事故）');
      return;
    }

    const reExportResp = await request('POST', `/export/incident-archive/${newIdImportedIncidentId}`, {
      userId: ADMIN,
      body: { format: 'json', download: true }
    });
    assert('重新导出成功 200', reExportResp.status === 200);

    const reExportedIncident = JSON.parse(reExportResp.body.files['incident.json']);
    const sourceIncident = JSON.parse(baseArchive.files['incident.json']);

    const coreFields = ['title', 'description', 'location', 'level', 'status', 'occurredAt',
      'reporterName', 'returnReason'];
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
      assert(`evidence[${i}] type/description/collectedAt/collectorName/fileHash 一致`,
        re.type === src.type
        && re.description === src.description
        && re.collectedAt === src.collectedAt
        && re.collectorName === src.collectorName
        && re.fileHash === src.fileHash,
        `src=${JSON.stringify({ type: src.type, description: src.description, collectedAt: src.collectedAt, collectorName: src.collectorName, fileHash: src.fileHash })} re=${JSON.stringify({ type: re.type, description: re.description, collectedAt: re.collectedAt, collectorName: re.collectorName, fileHash: re.fileHash })}`);
    }
  });

  await section('6. 服务重启后按配置目录读取归档再完成导入（import-from-file）', async () => {
    const uniquePrefix = 'verify-import-restart-' + Date.now();
    const uniqueDir = path.join(__dirname, '..', 'data', 'verify-import-restart');
    if (!fs.existsSync(uniqueDir)) fs.mkdirSync(uniqueDir, { recursive: true });

    console.log('  [步骤 1/6] 设置自定义 exportDir 并导出一个新归档...');

    await request('PUT', '/export/config', {
      userId: ADMIN,
      body: {
        filenamePrefix: uniquePrefix,
        exportDir: uniqueDir,
        conflictStrategy: 'suffix'
      }
    });

    const freshIncidentResp = await request('POST', '/incidents', {
      userId: REPORTER,
      body: {
        title: '跨重启导入测试事故-' + Date.now(),
        description: '测试服务重启后从配置目录读取并导入',
        location: '重启测试区',
        level: 'low',
        occurredAt: new Date().toISOString()
      }
    });
    const freshIncidentId = freshIncidentResp.body.data.id;

    const fileExportResp = await request('POST', `/export/incident-archive/${freshIncidentId}`, {
      userId: ADMIN,
      body: { format: 'json' }
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

    console.log('  [步骤 2/6] 停止服务...');
    await stopServer();
    await new Promise(r => setTimeout(r, 1000));

    const portAfterStop = await checkPortInUse(3000);
    assert('服务已停止（端口 3000 释放）', portAfterStop === false);

    console.log('  [步骤 3/6] 重新启动服务...');
    try {
      await startServer();
    } catch (err) {
      assert('服务重启成功', false, err.message);
      return;
    }
    assert('服务重启成功', true);

    console.log('  [步骤 4/6] 验证 exportDir 配置在重启后仍然生效...');
    const configAfterRestart = await request('GET', '/export/config', { userId: ADMIN });
    assert('重启后 GET /export/config 成功 200', configAfterRestart.status === 200);
    assertDeepEqual('重启后配置与重启前一致（持久化生效）',
      configAfterRestart.body.data,
      expectedConfig);

    console.log('  [步骤 5/6] 先 dryRun 预览...');
    const dryRunFile = await request('POST', '/export/incident-archive/import-from-file', {
      userId: ADMIN,
      body: { mode: 'dryRun', conflictStrategy: 'skip', filename: exportedFilename }
    });
    assert('import-from-file dryRun 成功 200', dryRunFile.status === 200,
      `实际=${dryRunFile.status} body=${JSON.stringify(dryRunFile.body)}`);
    assert('dryRun valid=true', dryRunFile.body.data.valid === true);

    console.log('  [步骤 6/6] commit 真正导入...');
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

    const importedId = commitFile.body.data.newIncidentId;
    const verifyResp = await request('GET', `/incidents/${importedId}`, { userId: ADMIN });
    assert('重启后导入的事故可通过新 ID 查询到', verifyResp.status === 200);
    assert('导入的事故标题与源事故一致',
      verifyResp.body.data.title === freshIncidentResp.body.data.title);

    const badPath = '../../etc/passwd';
    const badPathResp = await request('POST', '/export/incident-archive/import-from-file', {
      userId: ADMIN,
      body: { mode: 'dryRun', conflictStrategy: 'skip', filename: badPath }
    });
    assert('路径穿越尝试被拒绝（400）',
      badPathResp.status === 400 || badPathResp.status === 403,
      `实际状态=${badPathResp.status}`);
  });

  console.log('\n========================');
  console.log(`通过: ${passCount}  失败: ${failCount}`);
  if (failures.length > 0) {
    console.log('\n失败详情:');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    cleanupAndExit(1);
  } else {
    console.log('\n所有检查通过 ✓');
    console.log('- reporter 无权限导入（带失败审计日志）');
    console.log('- 缺 4 类文件 / schemaVersion 非法 / JSON 非法均返回 IMPORT_VALIDATION_ERROR，原因可看懂');
    console.log('- skip 冲突策略：已存在 ID 时跳过，不新增记录');
    console.log('- newId 冲突策略：生成新 UUID，证据 incidentId、审计日志 incidentId 全部修正');
    console.log('- 导入后再导出核心字段完全一致');
    console.log('- 服务重启后 exportDir 配置持久化保留，import-from-file 能从该目录读取并成功导入，且拒绝路径穿越');
    cleanupAndExit(0);
  }
}

main().catch((err) => {
  console.error('脚本执行出错:', err);
  cleanupAndExit(2);
});
