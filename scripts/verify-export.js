const http = require('http');

const BASE_URL = 'http://localhost:3000/api';
const ADMIN = 'admin-001';
const SECURITY = 'security-001';
const REPORTER = 'reporter-001';

let passCount = 0;
let failCount = 0;
const failures = [];

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

async function section(title, fn) {
  console.log(`\n=== ${title} ===`);
  await fn();
}

async function main() {
  console.log('导出功能可复现验证脚本');
  console.log('========================');

  const health = await request('GET', '/health');
  if (health.status !== 200) {
    console.error('服务未启动，请先运行 npm start');
    process.exit(1);
  }
  console.log('服务已连接 ✓');

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

  await section('1. 普通上报人（reporter）无权限导出', async () => {
    const r1 = await request('GET', '/export/incidents', { userId: REPORTER });
    assert('GET /export/incidents 返回 403', r1.status === 403, `实际状态: ${r1.status}`);
    assert('错误码为 PERMISSION_DENIED',
      r1.body && r1.body.error && r1.body.error.code === 'PERMISSION_DENIED');

    const r2 = await request('POST', `/export/incident-archive/${testIncidentId}`, {
      userId: REPORTER, body: { format: 'json' }
    });
    assert('POST /export/incident-archive 返回 403', r2.status === 403, `实际状态: ${r2.status}`);

    const r3 = await request('GET', '/export/config', { userId: REPORTER });
    assert('GET /export/config 返回 403', r3.status === 403, `实际状态: ${r3.status}`);

    const logsResp = await request('GET', `/incidents/${testIncidentId}/audit-logs`, { userId: ADMIN });
    const logsAll = (logsResp.body && logsResp.body.data) || [];
    const globalLogs = await request('GET', '/export/audit-logs', {
      userId: ADMIN, query: { action: 'data_export_failed', userId: REPORTER, format: 'json' }
    });
    const failedLogs = Array.isArray(globalLogs.body) ? globalLogs.body : [];
    assert('失败审计日志已写入（data_export_failed）',
      failedLogs.length > 0, `找到 ${failedLogs.length} 条失败日志`);
  });

  let savedArchivePath = null;
  let savedArchiveName = null;
  let manifestRef = null;

  await section('2. 单事故完整归档导出 — 内容一致性', async () => {
    const detailResp = await request('GET', `/incidents/${testIncidentId}`, { userId: ADMIN });
    const detail = detailResp.body.data;
    const expectedEvidenceCount = (detail.evidences || []).length;

    const logsResp = await request('GET', `/incidents/${testIncidentId}/audit-logs`, { userId: ADMIN });
    const expectedAuditCount = (logsResp.body && logsResp.body.data) ? logsResp.body.data.length : 0;

    const archiveResp = await request('POST', `/export/incident-archive/${testIncidentId}`, {
      userId: ADMIN, body: { format: 'json' }
    });

    assert('导出请求成功 200', archiveResp.status === 200, `实际状态: ${archiveResp.status}`);
    assert('success=true', archiveResp.body && archiveResp.body.success === true);

    const data = archiveResp.body.data;
    savedArchivePath = data.savedPath;
    savedArchiveName = data.finalName;
    manifestRef = data.manifest;

    assert('manifest 存在', !!data.manifest);
    assert('manifest.schemaVersion = 1.0', data.manifest && data.manifest.schemaVersion === '1.0');
    assert('manifest.exportedAt 为 ISO 时间',
      data.manifest && typeof data.manifest.exportedAt === 'string' && data.manifest.exportedAt.includes('T'));
    assert('manifest.exportId 非空', data.manifest && !!data.manifest.exportId);
    assert('manifest.dataFormat = json', data.manifest && data.manifest.dataFormat === 'json');
    assert('manifest.incidentId 匹配', data.manifest && data.manifest.incidentId === testIncidentId);
    assert('manifest.counts.incidents = 1',
      data.manifest && data.manifest.counts && data.manifest.counts.incidents === 1);
    assert(`manifest.counts.evidences = ${expectedEvidenceCount}`,
      data.manifest && data.manifest.counts && data.manifest.counts.evidences === expectedEvidenceCount,
      `实际 evidences=${data.manifest && data.manifest.counts && data.manifest.counts.evidences}`);
    assert('manifest.counts.auditLogs >= 0',
      data.manifest && data.manifest.counts && typeof data.manifest.counts.auditLogs === 'number');
    assert('manifest.files 包含 4 个文件',
      data.manifest && data.manifest.files && data.manifest.files.length === 4,
      `实际 ${data.manifest && data.manifest.files && data.manifest.files.length}`);
    assert('files 列表包含 manifest.json',
      data.files && data.files.includes('manifest.json'));
    assert('files 列表包含 incident.json',
      data.files && data.files.includes('incident.json'));
    assert('files 列表包含 evidences.json',
      data.files && data.files.includes('evidences.json'));
    assert('files 列表包含 audit_logs.json',
      data.files && data.files.includes('audit_logs.json'));
    assert('savedPath 非空', !!data.savedPath);
    assert('finalName 非空', !!data.finalName);

    const downloadResp = await request('GET', `/export/incident-archive/${testIncidentId}`, {
      userId: ADMIN, query: { download: 'true', format: 'json' }
    });
    assert('download=true 直接下载成功', downloadResp.status === 200);
    assert('下载响应含 manifest', !!downloadResp.body.manifest);
    assert('下载响应含 files', !!downloadResp.body.files);
    assert('下载 files 含 4 个条目', downloadResp.body.files && Object.keys(downloadResp.body.files).length === 4);
    const incidentContent = JSON.parse(downloadResp.body.files['incident.json']);
    assert('incident.json 内容 id 匹配', incidentContent.id === testIncidentId);
    const manifestContent = JSON.parse(downloadResp.body.files['manifest.json']);
    assert('manifest.json 自描述一致', manifestContent.exportId === downloadResp.body.manifest.exportId);
  });

  await section('3. 同名冲突处理（suffix 自动后缀 + error 策略）', async () => {
    if (!savedArchivePath) {
      console.log('  跳过（前一步未生成归档）');
      return;
    }

    const resp1 = await request('POST', `/export/incident-archive/${testIncidentId}`, {
      userId: ADMIN, body: { format: 'json' }
    });
    assert('默认 suffix 策略：再次导出不报错', resp1.status === 200, `实际 ${resp1.status}`);
    assert('自动添加后缀 renamed=true',
      resp1.body && resp1.body.data && resp1.body.data.renamed === true,
      `实际 renamed=${resp1.body && resp1.body.data && resp1.body.data.renamed}`);
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

  await section('4. 配置跨重启持久化 + CSV 格式归档', async () => {
    const uniquePrefix = 'verify-' + Date.now();
    const uniqueDir = require('path').join(__dirname, '..', 'data', 'verify-exports');

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
      putResp.body.data.exportDir === require('path').resolve(uniqueDir));

    const getResp = await request('GET', '/export/config', { userId: SECURITY });
    assert('GET /export/config 读取到相同配置', getResp.status === 200);
    assert('filenamePrefix 持久化匹配', getResp.body.data.filenamePrefix === uniquePrefix);
    assert('conflictStrategy 持久化匹配', getResp.body.data.conflictStrategy === 'suffix');

    const csvResp = await request('POST', `/export/incident-archive/${testIncidentId}`, {
      userId: ADMIN, body: { format: 'csv' }
    });
    assert('CSV 格式归档导出成功', csvResp.status === 200);
    assert('manifest.dataFormat = csv', csvResp.body.data.manifest.dataFormat === 'csv');
    assert('files 包含 incident.csv', csvResp.body.data.files.includes('incident.csv'));
    assert('files 包含 evidences.csv', csvResp.body.data.files.includes('evidences.csv'));
    assert('files 包含 audit_logs.csv', csvResp.body.data.files.includes('audit_logs.csv'));
    assert('文件名含自定义前缀', csvResp.body.data.finalName.startsWith(uniquePrefix));
    assert('文件保存在自定义目录',
      csvResp.body.data.savedPath.startsWith(require('path').resolve(uniqueDir)));

    const listResp = await request('GET', '/export/saved', { userId: ADMIN });
    assert('GET /export/saved 成功', listResp.status === 200);
    assert('已保存列表非空', Array.isArray(listResp.body.data) && listResp.body.data.length > 0);
    const savedItem = listResp.body.data[0];
    assert('列表条目含 filename', !!savedItem.filename);
    assert('列表条目含 fullPath', !!savedItem.fullPath);
    assert('列表条目含 manifest', !!savedItem.manifest && !!savedItem.manifest.exportId);

    const logsResp = await request('GET', '/export/audit-logs', {
      userId: ADMIN, query: { action: 'export_config_updated', format: 'json' }
    });
    const configLogs = Array.isArray(logsResp.body) ? logsResp.body : [];
    assert('配置更新审计日志已记录（export_config_updated）',
      configLogs.length > 0, `找到 ${configLogs.length} 条`);

    const successResp = await request('GET', '/export/audit-logs', {
      userId: ADMIN, query: { action: 'data_exported', format: 'json' }
    });
    const successLogs = Array.isArray(successResp.body) ? successResp.body : [];
    assert('成功导出审计日志已记录（data_exported）',
      successLogs.length > 0, `找到 ${successLogs.length} 条`);

    console.log('\n  【跨重启验证提示】');
    console.log(`    当前 filenamePrefix = ${uniquePrefix}`);
    console.log(`    当前 exportDir = ${require('path').resolve(uniqueDir)}`);
    console.log('    重启服务后执行:');
    console.log(`      curl -H "X-User-Id: admin-001" ${BASE_URL}/export/config`);
    console.log('    应返回相同的 filenamePrefix 和 exportDir，证明配置持久化生效。');

    await request('PUT', '/export/config', {
      userId: ADMIN, body: { filenamePrefix: 'duty-export', conflictStrategy: 'suffix' }
    });
  });

  console.log('\n========================');
  console.log(`通过: ${passCount}  失败: ${failCount}`);
  if (failures.length > 0) {
    console.log('\n失败详情:');
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    process.exit(1);
  } else {
    console.log('\n所有检查通过 ✓');
  }
}

main().catch((err) => {
  console.error('脚本执行出错:', err);
  process.exit(2);
});
