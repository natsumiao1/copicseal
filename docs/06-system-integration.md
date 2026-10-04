# 06 — 系统集成与存储

## 概述

本章定义前端分层、平台能力边界、素材基础设施与持久化策略。平台 Contract 的完整设计见 [11 — 平台能力抽象与 Provider 改造方案](./11-platform-abstraction.md)（已废弃存档，仅 Contract 语义部分继续有效）。

---

## 6.1 前端边界

前端实现范围全部限制在 `src/`：

```txt
src/
├── app/
├── features/
│   ├── template/
│   ├── collage/
│   └── settings/
├── core/
│   ├── renderer/
│   ├── scheduler/
│   ├── lifecycle/
│   └── constants/
├── platform/
│   ├── contracts/
│   ├── services/
│   └── providers/
├── bridge/           # 迁移期间仅供 Tauri Provider 内部使用
├── shared/
├── store/
└── utils/
```

---

## 6.2 分层职责

### `app`

- 应用初始化
- 路由与页面入口
- 全局布局壳层

### `features`

- `template`：边框水印业务
- `collage`：拼图业务
- `settings`：设置中心业务

### `core`

- 渲染稳定性控制
- 导出任务调度
- 生命周期管理

### `platform services`

- Export Pipeline、Asset Infrastructure
- 文件访问与缓存
- 数据库存储

### `bridge`

- 迁移期间封装 Tauri `invoke`
- 仅作为 `platform/providers/tauri` 的内部适配层
- 不作为 feature、`features/template/runtime` 或 core 的公开依赖

### `platform`

- 向业务公开图片、文件、存储、对话框、剪贴板、系统和窗口等稳定 Contract
- 只注册 Tauri Provider，不再提供 Web / WASM Provider
- 由 Service 统一执行编排与错误归一化，不再有跨宿主的选择性降级
- 提供 UI 可用的能力声明

---

## 6.3 Feature 独立原则

Collage 与 Template 完全独立，禁止：

- 共享编辑器
- 共享布局逻辑
- 共享状态

仅共享：

- Export Pipeline
- Asset Infrastructure

---

## 6.4 平台通信与 Provider

建议结构：

```txt
platform/
├── contracts/
├── services/
├── providers/
│   ├── tauri/
│   └── web/
├── capabilities.ts
├── errors.ts
└── index.ts
```

职责：

- 隔离业务代码与 Tauri 宿主细节
- 只注册 Tauri Provider；`PLATFORM_NOT_IMPLEMENTED` 与 `PLATFORM_UNSUPPORTED` 不再触发降级，直接上抛
- 实际解码、权限、参数、I/O 和存储错误必须原样转换后向上抛出

---

## 6.5 Asset Infrastructure

素材基础设施只提供底层能力，不提供全局素材工作区。

### 提供能力

- 文件导入
- 粘贴导入
- 文件夹扫描与目录枚举（子目录、图片列表、磁盘根）
- 缩略图生成（含直接以原文件为源的直览缩略图）
- 懒导入（图片被使用时才复制进缓存）
- 预览 URL 管理
- 最近打开的文件夹记录
- 缓存管理

### 不提供能力

- 全局素材库页面
- 跨页面共享素材面板
- 项目级素材归档

---

## 6.6 持久化策略

### 持久化内容

- Settings 默认配置
- 模板收藏
- 模板最近使用记录
- 缓存索引

### 不持久化为项目的内容

- Template 当前会话编辑状态
- Collage 当前会话编辑状态
- 全局工作区快照

---

## 6.7 文件系统与缓存

| 功能 | 说明 |
|------|------|
| 选择目录 | 调用系统目录选择器 |
| 打开文件 | 使用系统默认程序打开 |
| 打开文件夹 | 打开导出目录 |
| 目录枚举 | 列出子目录与图片文件路径，供文件夹树与直览栏使用，不复制原文件 |
| 直览缩略图 | 直接以原文件为源生成缩略图，按原路径哈希写入缓存 |
| 缩略图缓存 | 为素材栏提供快速展示 |
| 预览资源缓存 | 降低重复读取成本 |
| 主题色缓存 | 按图片缓存提取出的主题色，避免重复采样 |
| 最近文件夹 | 记录最近打开的目录，供文件夹树与会话恢复使用 |

通过 Tauri 访问用户明确授权的本地路径；导出直接写入目标目录，不再提供浏览器下载降级。

---

## 6.8 数据库存储

SQLite 用于存储轻量配置与索引：

| 数据类型 | 说明 |
|----------|------|
| General 设置 | 主题、语言、启动页等 |
| Template 默认配置 | 模板默认行为 |
| Collage 默认配置 | 拼图默认行为 |
| Export 默认配置 | 格式、倍率、质量 |
| 模板收藏与最近使用 | 提升模板选择体验 |
| 缓存索引 | 资源缓存定位 |

业务层只能通过 Storage Contract 访问它们。
---

## 6.9 2026-06-30 实现约束补充

### `shared/layouts`

- 只存放可复用布局组件
- 不直接判断当前业务页面，也不直接渲染 Template / Collage 的业务内容
- 通过 props 或 children 暴露 `Nav`、`Workspace`、`Assets`、`Properties` 等插槽

### `features/*` 页面职责

- `features/template` 与 `features/collage` 提供页面入口组件
- 页面组件引用 `shared/layouts` 进行组装，而不是由布局层反向承载页面逻辑
- 左侧内容区默认为上下分栏：上方 `Workspace`，下方 `Assets`
- Collage 可改用左侧双栏资源浏览器（文件夹树 + 图片预览栏），经由布局组件的可选插槽接入；Template 布局保持不变

---

## 6.10 运行环境原则

- Tauri 是唯一运行宿主，提供 Rust 图片处理、SQLite、原生文件与系统能力。
- 应用只以 Tauri 桌面形态启动，不再存在独立的浏览器运行版本。
- UI 使用 `platform.capabilities` 决定是否展示操作入口；调用时仍由 Provider 链处理实际支持情况。
- 不允许在页面组件中散落 `isTauri()`、`window.__TAURI__` 或浏览器 API 分支。

---

## 6.11 2026-10-04 拼图文件夹直览补充

### 布局插槽

- `shared/layouts/business-workbench` 提供可选的左侧栏插槽，`Assets` 变为可选
- Template 继续使用「Workspace + Assets」上下分栏
- Collage 使用「文件夹树 + 图片预览栏 + Workspace」，不再渲染下方 Assets

### 直览链路

```txt
打开文件夹 → 枚举目录图片路径（不复制原文件）
           → 图片预览栏按需生成缩略图（源为原文件）
           → 图片拖入画布 / 加入会话时才执行缓存导入
           → 后续预览与导出沿用既有缓存链路
```

### 会话与失效

- Collage 会话持久化 `folderPath`，启动时校验路径是否存在，失效则提示重新选择
- 最近打开的文件夹列表作为轻量状态持久化，供文件夹树根节点展示
- 目录内容变化通过手动刷新重新枚举，不依赖文件监听

### 平台边界

- 文件夹直览为桌面端能力，按 `platform.capabilities` 声明展示
- 产品已放弃 Web 端，直览无需任何浏览器降级路径
