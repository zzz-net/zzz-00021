const express = require('express');
const bodyParser = require('body-parser');
const routes = require('./routes');
const { createErrorResponse, ERROR_CODES } = require('./constants/errors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

app.use('/api', routes);

app.use('*', (req, res) => {
  res.status(404).json(createErrorResponse(ERROR_CODES.NOT_FOUND, '接口不存在: ' + req.originalUrl));
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json(createErrorResponse(ERROR_CODES.INTERNAL_ERROR, err.message));
});

app.listen(PORT, () => {
  console.log('========================================');
  console.log('  值班事故证据链 API 服务');
  console.log('========================================');
  console.log(`服务地址: http://localhost:${PORT}`);
  console.log(`API 前缀: http://localhost:${PORT}/api`);
  console.log(`健康检查: http://localhost:${PORT}/api/health`);
  console.log('');
  console.log('存储: SQLite (data/duty-incidents.db)');
  console.log('');
  console.log('初始化用户 (X-User-Id header):');
  console.log('  reporter-001  - 普通上报人 (reporter)');
  console.log('  foreman-001   - 班长 (foreman)');
  console.log('  security-001  - 安保人员 (security)');
  console.log('  admin-001     - 管理员 (admin)');
  console.log('');
  console.log('运行 npm run init 初始化用户数据');
  console.log('运行 npm run seed 生成示例事故/证据数据');
  console.log('========================================');
});

module.exports = app;
