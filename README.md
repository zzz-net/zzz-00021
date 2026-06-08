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
| RECEIPT_INCIDENT_NOT_CLOSED | 400    | 事故未结案，无法创建签收包               |
| RECEIPT_NO_EVIDENCE      | 400       | 事故无证据，无法创建签收包               |
| RECEIPT_EXPIRED          | 410       | 签收包已超过截止时间                     |
| RECEIPT_DUPLICATE        | 409       | 同一签收包不能重复签收                   |
| RECEIPT_INVALID_CODE     | 400       | 签收码格式错误或不存在                   |
| RECEIPT_ALREADY_SIGNED   | 409       | 签收包已完成签收                         |
| RECEIPT_REVOKED          | 410       | 签收包已被撤销                           |
| RECEIPT_CONFLICT         | 409       | 同一事故已有未完成签收包                 |
| RECEIPT_NOT_FOUND        | 404       | 签收包不存在                             |
| RECEIPT_CREATE_FAILED    | 500       | 签收包创建失败                           |
| RECEIPT_SIGN_FAILED      | 500       | 签收失败                                 |
| RECEIPT_REVOKE_FAILED    | 500       | 签收包撤销失败                           |
| SHIFT_HANDOVER_NOT_FOUND           | 404       | 交接班不存在                             |
| SHIFT_HANDOVER_CREATE_FAILED     | 500       | 交接班创建失败                           |
| SHIFT_HANDOVER_ALREADY_CONFIRMED  | 409       | 交接班已被确认，无法操作                    |
| SHIFT_HANDOVER_ALREADY_REVOKED | 409       | 交接班已被撤回，无法操作                    |
| SHIFT_HANDOVER_CONFIRM_FAILED    | 500       | 交接班确认失败                           |
| SHIFT_HANDOVER_REVOKE_FAILED     | 500       | 交接班撤回失败                           |
| SHIFT_HANDOVER_CONFLICT         | 409       | 交接班状态冲突                           |
| SHIFT_HANDOVER_NOT_CREATOR       | 409       | 仅交班人可撤回交接班                     |
| SHIFT_HANDOVER_INVALID_INCIDENT   | 400       | 关联的事故不存在                       |
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

### 5. 事故列表查询（值班台待办视图）

支持多维度筛选、排序和超时过滤。默认按创建时间降序排列。

**权限控制**：
- `admin` / `security` 角色：可查看全量事故
- `reporter` / `foreman` 角色：仅能查看自己上报或当前分配给自己处理的事故（后端强制过滤，不依赖前端）

每条事故返回附带 `overdue: true/false` 字段标识是否超时。

```bash
# 全部事故（受权限过滤）
curl -H "X-User-Id: reporter-001" http://localhost:3000/api/incidents

# 按地点筛选
curl -H "X-User-Id: reporter-001" "http://localhost:3000/api/incidents?location=A区"

# 按级别筛选
curl -H "X-User-Id: reporter-001" "http://localhost:3000/api/incidents?level=high"

# 按状态筛选
curl -H "X-User-Id: reporter-001" "http://localhost:3000/api/incidents?status=evidence_collecting"

# 按处理人筛选
curl -H "X-User-Id: security-001" "http://localhost:3000/api/incidents?assignedTo=reporter-001"

# 按创建时间范围筛选
curl -H "X-User-Id: security-001" "http://localhost:3000/api/incidents?createdFrom=2026-06-01T00:00:00.000Z&createdTo=2026-06-08T23:59:59.999Z"

# 只看超时事故
curl -H "X-User-Id: security-001" "http://localhost:3000/api/incidents?overdueOnly=true"

# 排序：按创建时间升序
curl -H "X-User-Id: security-001" "http://localhost:3000/api/incidents?sort=createdAt:asc"

# 排序：按更新时间降序（默认方向）
curl -H "X-User-Id: security-001" "http://localhost:3000/api/incidents?sort=updatedAt:desc"

# 排序：按等级升序（low → critical）
curl -H "X-User-Id: security-001" "http://localhost:3000/api/incidents?sort=level:asc"

# 排序：按等级降序（critical → low）
curl -H "X-User-Id: security-001" "http://localhost:3000/api/incidents?sort=level:desc"

# 组合筛选
curl -H "X-User-Id: security-001" "http://localhost:3000/api/incidents?location=B区&level=high&overdueOnly=true&sort=level:desc"
```

**请求参数说明**：

| 参数 | 类型 | 说明 |
|------|------|------|
| `location` | string | 按地点模糊匹配 |
| `level` | string | 按级别精确匹配：`low` / `medium` / `high` / `critical` |
| `status` | string | 按状态精确匹配 |
| `assignedTo` | string | 按当前处理人 ID 精确匹配 |
| `createdFrom` | string | 创建时间起始（ISO 8601），包含边界 |
| `createdTo` | string | 创建时间截止（ISO 8601），包含边界 |
| `overdueOnly` | boolean | `true` 时仅返回超时事故 |
| `sort` | string | 排序格式：`<字段>:<方向>`。字段：`createdAt` / `updatedAt` / `level`；方向：`asc` / `desc`（默认 `desc`） |

**非法 sort 值校验错误响应示例（400）**：
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "请求参数验证失败",
    "details": "sort 字段无效: invalidField。有效值: createdAt, updatedAt, level"
  }
}
```

---

### 5.1 超时配置管理

超时规则按事故等级分别配置（单位：小时），持久化存储在 SQLite，服务重启后仍然生效。修改配置会写入审计日志。

```bash
# 查看当前超时配置（所有已认证用户均可查看）
curl -H "X-User-Id: reporter-001" http://localhost:3000/api/incidents/config/overdue

# 修改超时配置（仅 admin 角色）
curl -X PUT -H "Content-Type: application/json" -H "X-User-Id: admin-001" \
  -d '{
    "low": 72,
    "medium": 48,
    "high": 24,
    "critical": 12
  }' \
  http://localhost:3000/api/incidents/config/overdue
```

**默认超时配置**：
| 等级 | 默认小时数 |
|------|-----------|
| `low` | 72 |
| `medium` | 48 |
| `high` | 24 |
| `critical` | 12 |

超时判定逻辑：已结案事故不视为超时；未结案事故从 `createdAt` 起算，超过对应等级配置的小时数即为超时。

**权限要求**：修改配置需要 `MANAGE_OVERDUE_CONFIG` 权限，仅 `admin` 角色拥有。

**审计日志**：配置变更会写入 `overdue_config_updated` 审计日志，记录变更前值、变更后值和具体变更字段。

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
    incidentId, incidentTitle,
    exportedBy: { userId, userName, userRole },
    filters,
    counts: { incidents, evidences, auditLogs, receiptPackages, receiptRecords },
    files: [...]
  },
  files: {
    'manifest.json': '...',
    'incident.json' | 'incident.csv': '...',
    'evidences.json' | 'evidences.csv': '...',
    'audit_logs.json' | 'audit_logs.csv': '...',
    'receipt_packages.json' | 'receipt_packages.csv': '...',
    'receipt_records.json' | 'receipt_records.csv': '...'
  }
}
```

**manifest 字段说明**：
| 字段 | 类型 | 说明 |
|------|------|------|
| `schemaVersion` | string | 归档格式版本，当前为 `1.0` |
| `exportedAt` | string | 导出时间（ISO 8601） |
| `exportId` | string | 本次导出的唯一 ID（UUID） |
| `dataFormat` | string | 内部文件格式：`json` 或 `csv` |
| `incidentId` | string | 事故 ID |
| `incidentTitle` | string | 事故标题 |
| `exportedBy` | object | 导出人信息：`userId`、`userName`、`userRole` |
| `filters` | object | 导出时使用的筛选条件 |
| `counts` | object | 各数据类型的记录数：`incidents`、`evidences`、`auditLogs`、`receiptPackages`、`receiptRecords` |
| `files` | string[] | 归档内包含的文件名列表 |

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

#### 导出权限控制与审计日志

所有导出相关接口（包括单独导出事故、证据、审计日志、事故归档包、导出配置管理、已保存列表）统一使用 `EXPORT_DATA` 权限进行控制，角色允许列表通过系统常量 `PERMISSIONS.EXPORT_DATA` 定义，确保权限判定与系统其他模块一致。

**权限矩阵**：
| 角色 | EXPORT_DATA 权限 | 说明 |
|------|------------------|------|
| `admin` | ✅ 允许 | 管理员 |
| `security` | ✅ 允许 | 安保人员 |
| `foreman` | ❌ 拒绝 | 班长，无导出权限 |
| `reporter` | ❌ 拒绝 | 普通上报人，无导出权限 |

**审计日志覆盖**：
| 场景 | 审计动作 | 说明 |
|------|----------|------|
| 导出成功 | `data_exported` | 记录导出类型、格式、数量、保存路径等 |
| 导出失败 | `data_export_failed` | 记录失败原因（权限不足、文件冲突、写入错误、事故不存在等） |
| 导出配置变更 | `export_config_updated` | 记录配置变更的字段和新值 |

无权限访问时，系统会：
1. 返回 HTTP 403 `PERMISSION_DENIED`，响应中包含 `required: 'EXPORT_DATA'`、当前用户角色 `userRole`、允许的角色列表 `allowedRoles`
2. 写入 `data_export_failed` 审计日志，附带 `type: 'permission_denied'`、请求路径、请求方法、用户角色等详情，便于事后审计追踪

**同名文件冲突处理**：
导出时通过 `conflictStrategy` 配置控制行为（存储于 SQLite，服务重启后保留）：
- `suffix`（默认）：自动生成安全后缀（`-1`、`-2`…），绝不会静默覆盖已有文件，响应中 `renamed: true` 标识发生了自动重命名
- `error`：返回 HTTP 409 `EXPORT_CONFLICT`，响应中 `details.existingPath` 指向冲突文件的绝对路径，`details.strategy` 为当前策略

---

### 16. 事故归档导入（恢复）

将之前通过"导出事故完整归档包"接口生成的 JSON 归档重新导入系统。支持两种模式、两种冲突策略，所有写入使用 SQLite 事务保证原子性——要么事故、证据、审计日志三者全部成功写入，要么全部回滚，不会遗留半导入数据。

**权限要求**：`admin` 或 `security` 角色。`reporter` / `foreman` 角色调用返回 403 `PERMISSION_DENIED`，并写入 `data_import_failed` 审计日志。

**导入流程一览**：
1. 结构校验：`manifest`、`files` 是否存在，`manifest.json` / `incident.json` / `evidences.json` / `audit_logs.json` 四类文件是否齐全
2. manifest 自描述校验：`schemaVersion`（必须为 `1.0`）、`dataFormat`（仅支持 `json`）、`exportId`、`incidentId`、`counts` 计数是否与实际内容匹配
3. 内容校验：事故必填字段、证据数组结构、审计日志数组结构
4. 冲突检测：目标事故 ID 是否已存在
5. 执行：`dryRun` 仅返回差异预览，`commit` 事务性写入

#### 方式一：直接提交归档内容（适合从下载的 .json 归档恢复）

```bash
# 1) dryRun 模式：仅执行完整校验并返回差异预览，不写入任何数据
curl -X POST -H "Content-Type: application/json" -H "X-User-Id: admin-001" \
  "http://localhost:3000/api/import/archive?mode=dryRun&conflictStrategy=newId" \
  -d '{
    "manifest": {
      "schemaVersion": "1.0",
      "exportedAt": "2026-06-08T05:17:55.457Z",
      "exportId": "cac86c8e-50b7-46ee-8b2f-ec57fb4776ac",
      "dataFormat": "json",
      "incidentId": "f0cc5099-ce4c-4111-ab2f-fbdca3b4ae31",
      "incidentTitle": "D区仓库漏水",
      "counts": { "incidents": 1, "evidences": 2, "auditLogs": 5, "receiptPackages": 1, "receiptRecords": 1 },
      "files": ["incident.json", "evidences.json", "audit_logs.json", "manifest.json", "receipt_packages.json", "receipt_records.json"]
    },
    "files": {
      "manifest.json": "{...}",
      "incident.json": "{...}",
      "evidences.json": "[...]",
      "audit_logs.json": "[...]",
      "receipt_packages.json": "[...]",
      "receipt_records.json": "[...]"
    }
  }'

# 2) commit 模式：真正写入数据（建议先 dryRun 确认差异再执行 commit）
curl -X POST -H "Content-Type: application/json" -H "X-User-Id: admin-001" \
  "http://localhost:3000/api/import/archive?mode=commit&conflictStrategy=newId" \
  -d '{ /* 与 dryRun 相同的归档内容 */ }'
```

#### 方式二：从服务端导出目录读取已保存的归档恢复（推荐）

归档文件必须位于通过 `/api/export/config` 配置的 `exportDir` 目录（含其所有子目录）内；路径必须真实收敛在该目录边界内——同前缀兄弟目录、`../` 上级穿越、其他盘符/根目录均会被拒绝。

```bash
# 先列出当前导出目录下已保存的归档
curl -H "X-User-Id: admin-001" "http://localhost:3000/api/export/saved"

# dryRun 预览（filename 支持文件名或绝对路径）
curl -X POST -H "Content-Type: application/json" -H "X-User-Id: admin-001" \
  -d '{
    "mode": "dryRun",
    "conflictStrategy": "skip",
    "filename": "duty-export-2026-06-08-incident-498f3b57-6e7e-4f01-ac10-9851fee60a31-json.json"
  }' \
  "http://localhost:3000/api/export/incident-archive/import-from-file"

# commit 真正导入
curl -X POST -H "Content-Type: application/json" -H "X-User-Id: admin-001" \
  -d '{
    "mode": "commit",
    "conflictStrategy": "newId",
    "filename": "duty-export-2026-06-08-incident-498f3b57-6e7e-4f01-ac10-9851fee60a31-json.json"
  }' \
  "http://localhost:3000/api/export/incident-archive/import-from-file"
```

**请求参数**：
| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `archive` | object | - | （方式一必填）完整归档内容，必须包含顶层 `manifest` 和 `files` 字段 |
| `filename` | string | - | （方式二必填）导出目录下的文件名，或绝对路径（必须真实位于 `exportDir` 目录树内） |
| `mode` | string | `dryRun` | 运行模式：`dryRun` 仅校验与预览差异，`commit` 实际写入 |
| `conflictStrategy` | string | `skip` | 事故 ID 冲突策略：`skip` 冲突时跳过不写入，`newId` 生成新 UUID 并自动修正证据、审计日志的所有 incidentId 引用 |

**dryRun 成功响应示例（200）**：
```json
{
  "success": true,
  "data": {
    "mode": "dryRun",
    "valid": true,
    "readyForCommit": true,
    "strategy": "newId",
    "diff": {
      "exportId": "cac86c8e-50b7-46ee-8b2f-ec57fb4776ac",
      "exportedAt": "2026-06-08T05:17:55.457Z",
      "sourceIncident": {
        "id": "f0cc5099-ce4c-4111-ab2f-fbdca3b4ae31",
        "title": "D区仓库漏水",
        "status": "reported",
        "level": "medium"
      },
      "conflict": {
        "exists": true,
        "strategy": "newId",
        "existingId": "f0cc5099-ce4c-4111-ab2f-fbdca3b4ae31"
      },
      "plan": {
        "skipped": false,
        "oldIncidentId": "f0cc5099-ce4c-4111-ab2f-fbdca3b4ae31",
        "newIncidentId": "新的UUID（仅 newId 策略且发生冲突时有值）",
        "incidentWillBeCreated": true,
        "evidencesCount": 2,
        "auditLogsCount": 5,
        "remapped": true
      },
      "counts": { "incidents": 1, "evidences": 2, "auditLogs": 5 }
    }
  }
}
```

**校验失败响应示例（400）**：
```json
{
  "success": false,
  "error": {
    "code": "IMPORT_VALIDATION_ERROR",
    "message": "归档校验失败",
    "details": {
      "reason": "归档内容校验失败",
      "errors": [
        "缺少文件内容: evidences.json",
        "incident.title 缺失或为空"
      ],
      "exportId": "cac86c8e-50b7-46ee-8b2f-ec57fb4776ac"
    }
  }
}
```

**路径越界响应示例（400）**：
```json
{
  "success": false,
  "error": {
    "code": "IMPORT_VALIDATION_ERROR",
    "message": "归档校验失败",
    "details": {
      "reason": "归档文件路径不在配置的导出目录范围内",
      "hint": "仅允许读取 exportDir 配置目录（含子目录）下的归档文件；不可使用 ../ 等路径穿越到上级目录，也不可读取同前缀的兄弟目录",
      "requestedPath": "../exports-evil/malicious.json",
      "requestedResolved": "D:\\workSpace\\AI__SPACE\\zzz-00021\\data\\exports-evil\\malicious.json",
      "exportDir": "D:\\workSpace\\AI__SPACE\\zzz-00021\\data\\exports"
    }
  }
}
```

**审计日志**：
- 导入成功 → `data_imported`
- 归档校验失败 → `data_import_validation_failed`
- 权限拒绝、路径越界、读取异常、写入异常 → `data_import_failed`

所有审计日志均附带 `exportId`、策略、原因等详情，可通过 `/api/export/audit-logs` 查询。

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
| app_config  | 应用配置（导出目录、文件名前缀、冲突策略等，服务重启后保持生效） |

数据库文件位置：`data/duty-incidents.db`，可使用任意 SQLite 工具直接打开查看。

导出归档默认保存在 `data/exports/` 目录下，可通过 `/api/export/config` 接口修改。

## 导出验证脚本

在 `scripts/verify-export.js` 提供了完整的可复现验证脚本，覆盖以下场景：

1. 普通上报人（reporter）无权限导出 → 返回 403，并写入失败审计日志
2. 事故完整归档包导出内容一致性 → manifest 计数、文件列表与实际数据核对（JSON 和 CSV 两种内部格式）
3. 同名冲突处理（suffix 策略自动加后缀；error 策略返回 409 明确冲突）
4. CSV 归档、已保存列表、成功/失败/配置变更三类审计日志
5. **配置跨重启持久化** — 脚本自动执行：设置导出目录和文件名前缀 → 停止服务 → 重新启动服务 → 读取配置并深度断言完全一致；失败时打印逐字段差异并退出非零

运行方式：
```bash
# 重要：运行前请先停止所有占用 3000 端口的进程（如手动启动的 npm start）
# 脚本会自己以子进程方式启动和停止服务，完成跨重启验证
node scripts/verify-export.js
```

退出码约定：
| 退出码 | 含义 |
|--------|------|
| 0 | 所有检查通过 |
| 1 | 存在断言失败（失败详情会逐行打印，包括跨重启配置差异） |
| 2 | 脚本执行异常（服务启动失败、未捕获异常等） |
| 130 | 用户 Ctrl+C 中断 |

## 导入验证脚本

在 `scripts/verify-import.js` 提供了导入链路的完整可复现验证脚本，覆盖以下场景：

1. **配置持久化（跨重启）**：设置自定义 `exportDir` 和文件名前缀 → 停止服务 → 重启服务 → 读取配置并断言逐字段完全一致
2. **无权限测试**：普通上报人（reporter）尝试导入（archive 提交和 import-from-file 两种方式）→ 返回 403 `PERMISSION_DENIED`，并写入 `data_import_failed` 审计日志
3. **目录边界与安全校验**：
   - 路径穿越（`../../etc/passwd`）→ 400 拒绝
   - 同名前缀兄弟目录（`data/exports-evil/` 冒充 `data/exports/`）→ 400 拒绝
   - 目录本身作为 filename → 400 拒绝
   - 不存在的文件 → 404 `NOT_FOUND`
   - 所有失败均写入对应审计日志，错误响应中 `details.reason` 可看懂
4. **缺文件 / JSON 格式校验失败**：故意删除 manifest / incident / evidences / audit_logs 中任意一个文件，或损坏 JSON 语法 → 返回 400 `IMPORT_VALIDATION_ERROR`，错误响应中包含明确原因，并写入 `data_import_validation_failed` 审计日志
5. **冲突策略测试**：
   - `skip` 策略：已存在事故 ID 时跳过，不写入新数据
   - `newId` 策略：已存在事故 ID 时自动生成新 UUID，并自动修正证据和审计日志中的 incidentId 引用
6. **导入导出一致性**：导入（newId 策略）→ 立即重新导出该事故 → 深度对比事故核心字段（title/description/location/level/status/occurredAt/reporterName）和证据属性（type/description/collectedAt/collectorName/fileHash）完全一致
7. **服务重启后按最新配置目录读取归档**：
   - 设置自定义 exportDir → 导出归档到该目录 → 停止服务 → 重启服务 → 验证配置保留 → 通过 `GET /api/export/archives` 列出归档 → 用 `import-from-file` 接口从该目录读取归档并成功 dryRun + commit
8. **列出可导入归档接口（GET /export/archives）**：断言返回的每一项都含 filename、filePath、size、mtime、exportDir 和 manifest 摘要，且 reporter 角色无权限访问

运行方式：
```bash
# 重要：运行前请先停止所有占用 3000 端口的进程（如手动启动的 npm start）
# 脚本会自己以子进程方式启动和停止服务，完成跨重启验证
node scripts/verify-import.js
```

退出码约定：
| 退出码 | 含义 |
|--------|------|
| 0 | 所有检查通过 |
| 1 | 存在断言失败（失败详情逐行打印） |
| 2 | 脚本执行异常（服务启动失败、未捕获异常等） |
| 130 | 用户 Ctrl+C 中断 |

## 事故列表/待办视图验证脚本

在 `scripts/verify-incident-list.js` 提供了事故列表和待办视图的完整可复现验证脚本，覆盖以下场景：

1. **跨重启配置持久化**：设置自定义超时小时数 → 停止服务 → 重新启动服务 → 读取配置并深度断言逐字段完全一致
2. **无权限列表过滤**：
   - reporter 角色只能看到自己上报或分配给自己的事故
   - admin/security 角色可以看到全量事故
   - 通过后端接口强制验证，不依赖前端约定
3. **非法筛选参数校验**：
   - 非法 sort 字段 → 返回 400 VALIDATION_ERROR，包含明确的有效值提示
   - 非法 sort 方向 → 返回 400 VALIDATION_ERROR
   - 非法日期格式 → 返回 400 VALIDATION_ERROR
4. **排序稳定性验证**：
   - createdAt 升序/降序
   - updatedAt 升序/降序
   - level 升序（low→critical）/降序（critical→low）
   - 同值次级排序稳定（按 createdAt 降序作为 tie-breaker）
5. **超时筛选**：
   - 配置短超时（如 0 小时）让新事故立即超时
   - overdueOnly=true 仅返回超时事故
   - 每条事故记录都附带 overdue 字段
   - 已结案事故不视为超时
6. **审计日志验证**：修改超时配置后写入 `overdue_config_updated` 审计日志，记录 before/after/changes

运行方式：
```bash
# 重要：运行前请先停止所有占用 3000 端口的进程（如手动启动的 npm start）
# 脚本会自己以子进程方式启动和停止服务，完成跨重启验证
node scripts/verify-incident-list.js
```

退出码约定：
| 退出码 | 含义 |
|--------|------|
| 0 | 所有检查通过 |
| 1 | 存在断言失败（失败详情会逐行打印，包括跨重启配置差异） |
| 2 | 脚本执行异常（服务启动失败、未捕获异常等） |
| 130 | 用户 Ctrl+C 中断 |

## 目录结构

```
.
├── src/
│   ├── server.js          # 服务入口
│   ├── constants/         # 状态、角色、错误码定义
│   ├── middleware/        # 认证和权限中间件
│   ├── storage/           # SQLite 存储层（sqliteStore.js）
│   ├── services/          # 业务逻辑层（含 configService、exportService、importService）
│   └── routes/            # API 路由
├── scripts/
│   ├── init.js            # 初始化用户数据（SQLite）
│   ├── seed.js            # 生成示例数据（SQLite）
│   ├── verify-export.js   # 导出功能可复现验证脚本
│   ├── verify-import.js   # 导入功能可复现验证脚本
│   └── verify-incident-list.js  # 事故列表/待办视图验证脚本
├── data/
│   ├── duty-incidents.db  # SQLite 数据库
│   └── exports/           # 默认导出归档目录
├── package.json
└── README.md
```
