# 值班事故证据链 JSON API

本地值班事故证据链管理系统，支持事故上报、证据登记、班长复核、安保确认、结案/退回的完整流程，所有状态变更记录追加式审计日志。

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 初始化数据

```bash
# 初始化用户和基础数据
npm run init

# 生成示例事故和证据数据
npm run seed
```

### 3. 启动服务

```bash
npm start
```

服务默认运行在 `http://localhost:3000`，API 前缀为 `/api`。

## 默认用户

初始化后可用以下用户 ID 作为请求 Header `X-User-Id`:

| 用户 ID        | 姓名   | 角色     | 权限说明                     |
|----------------|--------|----------|------------------------------|
| reporter-001   | 张三   | reporter | 普通上报人：上报事故、登记证据 |
| reporter-002   | 李四   | reporter | 普通上报人                   |
| foreman-001    | 王班长 | foreman  | 班长：复核事故、退回         |
| security-001   | 赵安保 | security | 安保：确认、结案、退回       |
| admin-001      | 孙管理 | admin    | 管理员：所有权限             |

## 事故状态流转

```
reported (已上报)
    ↓
evidence_collecting (证据收集中) ←─────────────────┐
    ↓                                                │
foreman_reviewed (班长已复核)                        │
    ↓                                                │ reopen
security_confirmed (安保已确认)                      │ (security/admin)
    ↓                                                │
closed (已结案) ─────────────────────────────────────┘

任何状态均可 → returned (已退回) → evidence_collecting
```

> **重要**：`closed（已结案）` 状态下，所有状态流转接口（`start-evidence` / `return` / `foreman-review` / `security-confirm` / `close`）以及证据登记接口，**全部**返回 `INCIDENT_CLOSED` 错误，状态不会改变、不会写入证据、不会写成功审计日志。唯一合法入口是 `POST /incidents/:id/reopen`（security 或 admin 角色），将事故流转回 `evidence_collecting` 后才能继续登记证据。

## 错误响应格式

所有错误响应统一格式：

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "错误描述",
    "details": {}
  }
}
```

### 错误码说明

| 错误码                   | HTTP 状态 | 说明                                     |
|--------------------------|-----------|------------------------------------------|
| VALIDATION_ERROR         | 400       | 请求参数验证失败                         |
| UNAUTHORIZED             | 401       | 未授权，缺少或无效的 X-User-Id           |
| PERMISSION_DENIED        | 403       | 权限不足                                 |
| NOT_FOUND                | 404       | 资源不存在                               |
| INVALID_STATUS_TRANSITION| 400       | 无效的状态流转                           |
| EVIDENCE_TIME_TOO_EARLY  | 400       | 证据采集时间早于事故发生时间             |
| DUPLICATE_EVIDENCE_HASH  | 409       | 同一事故下已存在相同哈希的证据           |
| INTERNAL_ERROR           | 500       | 服务器内部错误                           |

## API 接口

所有接口需在 Header 中携带 `X-User-Id: <用户ID>` 进行身份认证。

---

### 1. 健康检查

```bash
curl http://localhost:3000/api/health
```

### 2. 获取常量定义

```bash
curl http://localhost:3000/api/constants
```

### 3. 获取当前用户信息

```bash
curl -H "X-User-Id: reporter-001" http://localhost:3000/api/users/me
```

---

### 4. 创建事故（上报）

```bash
curl -X POST http://localhost:3000/api/incidents \
  -H "Content-Type: application/json" \
  -H "X-User-Id: reporter-001" \
  -d '{
    "title": "D区仓库漏水",
    "description": "D区3号仓库顶部漏水，可能影响库存物资",
    "location": "D区3号仓库",
    "level": "medium",
    "occurredAt": "2026-06-08T08:30:00.000Z"
  }'
```

**请求参数**：
- `title` (必填): 事故标题
- `location` (必填): 事故地点
- `level` (必填): 事故级别 `low | medium | high | critical`
- `description`: 事故描述
- `occurredAt`: 事故发生时间（ISO 8601），默认当前时间

**成功响应**（201）：
```json
{
  "success": true,
  "data": {
    "id": "事故ID",
    "status": "reported",
    "evidenceCount": 0
  }
}
```

---

### 5. 事故列表查询

支持按地点、级别、状态筛选：

```bash
# 全部事故
curl -H "X-User-Id: reporter-001" http://localhost:3000/api/incidents

# 按地点筛选
curl -H "X-User-Id: reporter-001" "http://localhost:3000/api/incidents?location=A区"

# 按级别筛选
curl -H "X-User-Id: reporter-001" "http://localhost:3000/api/incidents?level=high"

# 按状态筛选
curl -H "X-User-Id: reporter-001" "http://localhost:3000/api/incidents?status=evidence_collecting"

# 组合筛选
curl -H "X-User-Id: reporter-001" "http://localhost:3000/api/incidents?location=B区&level=medium&status=reported"
```

---

### 6. 事故详情（含证据列表）

```bash
curl -H "X-User-Id: reporter-001" http://localhost:3000/api/incidents/<事故ID>
```

---

### 7. 开始证据收集

```bash
curl -X POST http://localhost:3000/api/incidents/<事故ID>/start-evidence \
  -H "X-User-Id: reporter-001"
```

---

### 8. 登记证据

```bash
curl -X POST http://localhost:3000/api/incidents/<事故ID>/evidences \
  -H "Content-Type: application/json" \
  -H "X-User-Id: reporter-001" \
  -d '{
    "type": "photo",
    "description": "仓库漏水点现场照片",
    "collectedAt": "2026-06-08T09:15:00.000Z",
    "filePath": "/data/photos/d-warehouse-leak-001.jpg",
    "fileHash": "sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
  }'
```

**请求参数**：
- `type`: 证据类型 `photo | video | document | audio | other`
- `description`: 证据描述
- `collectedAt`: 采集时间（ISO 8601），必须晚于事故发生时间
- `filePath` 或 `fileHash` (至少一项): 附件路径或文件哈希

**业务约束验证**：
- 证据采集时间不能早于事故发生时间（返回 `EVIDENCE_TIME_TOO_EARLY`）
- 同一事故下相同 `fileHash` 不能重复提交（返回 `DUPLICATE_EVIDENCE_HASH`）

---

### 9. 查看事故证据列表

```bash
curl -H "X-User-Id: reporter-001" http://localhost:3000/api/incidents/<事故ID>/evidences
```

---

### 10. 班长复核

```bash
curl -X POST http://localhost:3000/api/incidents/<事故ID>/foreman-review \
  -H "X-User-Id: foreman-001"
```

> 权限要求：`foreman` 或 `admin` 角色

---

### 11. 安保确认

```bash
curl -X POST http://localhost:3000/api/incidents/<事故ID>/security-confirm \
  -H "X-User-Id: security-001"
```

> 权限要求：`security` 或 `admin` 角色
> 
> **失败场景示例（普通上报人尝试安保确认）**：
> ```bash
> curl -X POST http://localhost:3000/api/incidents/<事故ID>/security-confirm \
>   -H "X-User-Id: reporter-001"
> ```
> 返回 403：
> ```json
> {
>   "success": false,
>   "error": {
>     "code": "PERMISSION_DENIED",
>     "message": "权限不足，无法执行该操作"
>   }
> }
> ```

---

### 12. 退回事故

```bash
curl -X POST http://localhost:3000/api/incidents/<事故ID>/return \
  -H "Content-Type: application/json" \
  -H "X-User-Id: foreman-001" \
  -d '{
    "reason": "证据不充分，需要补充现场照片和维修记录"
  }'
```

> 权限要求：`foreman`、`security` 或 `admin` 角色

---

### 13. 结案

```bash
curl -X POST http://localhost:3000/api/incidents/<事故ID>/close \
  -H "X-User-Id: security-001"
```

> 权限要求：`security` 或 `admin` 角色

---

### 14. 查看事故审计日志

```bash
curl -H "X-User-Id: reporter-001" http://localhost:3000/api/incidents/<事故ID>/audit-logs
```

---

### 15. 数据导出

支持 JSON 和 CSV 两种格式，通过 `?format=csv` 或 `?format=json` 指定。

#### 导出事故数据

```bash
# JSON 格式
curl -H "X-User-Id: admin-001" "http://localhost:3000/api/export/incidents" -o incidents.json

# CSV 格式
curl -H "X-User-Id: admin-001" "http://localhost:3000/api/export/incidents?format=csv" -o incidents.csv
```

#### 导出证据数据

```bash
# 全部证据
curl -H "X-User-Id: admin-001" "http://localhost:3000/api/export/evidences?format=csv" -o evidences.csv

# 指定事故的证据
curl -H "X-User-Id: admin-001" "http://localhost:3000/api/export/evidences?incidentId=<事故ID>&format=csv" -o evidences.csv
```

#### 导出审计日志

```bash
# 全部日志
curl -H "X-User-Id: admin-001" "http://localhost:3000/api/export/audit-logs?format=csv" -o audit_logs.csv

# 按条件筛选
curl -H "X-User-Id: admin-001" \
  "http://localhost:3000/api/export/audit-logs?action=incident_status_changed&userId=foreman-001&format=json"
```

#### 导出事故完整归档包（推荐）

一次性导出某个事故的全部信息：事故详情、证据列表、相关审计日志、以及一份 manifest 文件，支持 JSON / CSV 两种内部数据格式。

归档包内容结构：
```
{
  manifest: {
    schemaVersion, exportedAt, exportId, dataFormat,
    incidentId, incidentTitle, filters,
    counts: { incidents, evidences, auditLogs },
    files: [...]
  },
  files: {
    'manifest.json': '...',
    'incident.json' | 'incident.csv': '...',
    'evidences.json' | 'evidences.csv': '...',
    'audit_logs.json' | 'audit_logs.csv': '...'
  }
}
```

**方式一：保存到服务端导出目录（默认）**

```bash
# JSON 格式内部文件
curl -X POST -H "Content-Type: application/json" -H "X-User-Id: admin-001" \
  "http://localhost:3000/api/export/incident-archive/<事故ID>"

# CSV 格式内部文件
curl -X POST -H "Content-Type: application/json" -H "X-User-Id: admin-001" \
  -d '{"format":"csv"}' \
  "http://localhost:3000/api/export/incident-archive/<事故ID>"
```

成功响应：
```json
{
  "success": true,
  "data": {
    "manifest": { ... },
    "savedPath": "D:\\...\\data\\exports\\duty-export-2026-06-08-incident-xxx-json.json",
    "finalName": "duty-export-2026-06-08-incident-xxx-json.json",
    "renamed": false,
    "files": ["manifest.json", "incident.json", "evidences.json", "audit_logs.json"]
  }
}
```

**方式二：直接下载（不写入磁盘）**

```bash
curl -H "X-User-Id: admin-001" \
  "http://localhost:3000/api/export/incident-archive/<事故ID>?download=true&format=csv" \
  -o incident-archive.json
```

#### 导出配置管理（持久化，重启生效）

```bash
# 查看当前配置
curl -H "X-User-Id: admin-001" "http://localhost:3000/api/export/config"

# 修改配置（可部分更新）
curl -X PUT -H "Content-Type: application/json" -H "X-User-Id: admin-001" \
  -d '{
    "exportDir": "D:/duty-exports",
    "filenamePrefix": "company-duty",
    "conflictStrategy": "error"
  }' \
  "http://localhost:3000/api/export/config"
```

配置项说明：
| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| exportDir | string | data/exports | 导出文件保存目录（自动创建，绝对/相对路径均可） |
| filenamePrefix | string | duty-export | 导出文件名前缀 |
| conflictStrategy | string | suffix | 同名冲突处理策略：`suffix` 自动追加数字后缀，`error` 返回 409 冲突错误，不静默覆盖 |

#### 查看已保存的归档列表

```bash
curl -H "X-User-Id: admin-001" "http://localhost:3000/api/export/saved"
```

> 权限要求：`admin` 或 `security` 角色。普通上报人（reporter）和班长（foreman）无法访问导出接口，且会写入失败审计日志。

---

## 失败路径测试示例

### 1. 证据时间早于事故发生时间

```bash
# 假设事故发生在 2026-06-08T10:00:00.000Z
curl -X POST http://localhost:3000/api/incidents/<事故ID>/evidences \
  -H "Content-Type: application/json" \
  -H "X-User-Id: reporter-001" \
  -d '{
    "description": "测试证据",
    "collectedAt": "2026-06-08T09:00:00.000Z",
    "fileHash": "sha256:test123"
  }'
```

返回 400：
```json
{
  "success": false,
  "error": {
    "code": "EVIDENCE_TIME_TOO_EARLY",
    "message": "证据采集时间早于事故发生时间",
    "details": {
      "evidenceCollectedAt": "2026-06-08T09:00:00.000Z",
      "incidentOccurredAt": "2026-06-08T10:00:00.000Z"
    }
  }
}
```

### 2. 重复提交相同哈希证据

```bash
# 第一次提交
curl -X POST http://localhost:3000/api/incidents/<事故ID>/evidences \
  -H "Content-Type: application/json" \
  -H "X-User-Id: reporter-001" \
  -d '{"fileHash": "sha256:duplicate_test_001"}'

# 第二次提交相同哈希
curl -X POST http://localhost:3000/api/incidents/<事故ID>/evidences \
  -H "Content-Type: application/json" \
  -H "X-User-Id: reporter-001" \
  -d '{"fileHash": "sha256:duplicate_test_001"}'
```

第二次返回 409：
```json
{
  "success": false,
  "error": {
    "code": "DUPLICATE_EVIDENCE_HASH",
    "message": "同一事故下已存在相同哈希的证据",
    "details": {
      "duplicateEvidenceId": "已存在证据的ID",
      "fileHash": "sha256:duplicate_test_001"
    }
  }
}
```

### 3. 普通上报人尝试安保确认

```bash
curl -X POST http://localhost:3000/api/incidents/<事故ID>/security-confirm \
  -H "X-User-Id: reporter-001"
```

返回 403：
```json
{
  "success": false,
  "error": {
    "code": "PERMISSION_DENIED",
    "message": "权限不足，无法执行该操作"
  }
}
```

### 4. 无效的状态流转

```bash
# 直接从 reported 跳到 security_confirmed（跳过证据收集和班长复核）
curl -X POST http://localhost:3000/api/incidents/<事故ID>/security-confirm \
  -H "X-User-Id: security-001"
```

返回 400：
```json
{
  "success": false,
  "error": {
    "code": "INVALID_STATUS_TRANSITION",
    "message": "无效的状态流转",
    "details": {
      "currentStatus": "reported",
      "targetStatus": "security_confirmed",
      "allowedTransitions": ["evidence_collecting", "returned"]
    }
  }
}
```

### 5. 结案后新增证据被拒绝

```bash
# 假设事故已流转到 closed 状态
curl -X POST http://localhost:3000/api/incidents/<事故ID>/evidences \
  -H "Content-Type: application/json" \
  -H "X-User-Id: reporter-001" \
  -d '{
    "description": "结案后试图补充证据",
    "collectedAt": "2026-06-08T12:00:00.000Z",
    "fileHash": "sha256:attempt_after_close"
  }'
```

返回 400（不写入证据、不产生成功审计日志）：
```json
{
  "success": false,
  "error": {
    "code": "INCIDENT_CLOSED",
    "message": "事故已结案，无法新增证据，如需补充请先申请重新打开",
    "details": {
      "incidentId": "<事故ID>",
      "currentStatus": "closed"
    }
  }
}
```

### 6. 结案后试图通过 start-evidence 绕过（同样被拒绝）

> `closed` 状态下 **所有状态流转接口**（`start-evidence` / `return` / `foreman-review` / `security-confirm` / `close`）都会返回 `INCIDENT_CLOSED`，**仅** `reopen`（security/admin 权限）是唯一合法入口。

```bash
curl -X POST http://localhost:3000/api/incidents/<事故ID>/start-evidence \
  -H "X-User-Id: reporter-001"
```

返回 400（状态不变、不写成功审计）：
```json
{
  "success": false,
  "error": {
    "code": "INCIDENT_CLOSED",
    "message": "事故已结案，无法新增证据，如需补充请先申请重新打开",
    "details": {
      "incidentId": "<事故ID>",
      "currentStatus": "closed",
      "hint": "事故已结案，仅支持通过 reopen 接口重新打开"
    }
  }
}
```

## 数据持久化

所有数据存储在 `data/duty-incidents.db`（SQLite 数据库）中，服务重启后证据顺序、当前状态、处理人和审计记录全部保留：

| 表名        | 内容             |
|-------------|------------------|
| users       | 用户数据         |
| incidents   | 事故数据         |
| evidences   | 证据数据         |
| audit_logs  | 追加式审计日志（带 sequence 序号） |

数据库文件位置：`data/duty-incidents.db`，可使用任意 SQLite 工具直接打开查看。

## 目录结构

```
.
├── src/
│   ├── server.js          # 服务入口
│   ├── constants/         # 状态、角色、错误码定义
│   ├── middleware/        # 认证和权限中间件
│   ├── storage/           # SQLite 存储层（sqliteStore.js）
│   ├── services/          # 业务逻辑层
│   └── routes/            # API 路由
├── scripts/
│   ├── init.js            # 初始化用户数据（SQLite）
│   └── seed.js            # 生成示例数据（SQLite）
├── data/                  # 数据目录（运行时生成 duty-incidents.db）
├── package.json
└── README.md
```
