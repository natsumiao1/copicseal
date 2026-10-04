# 08 — 产品需求规格

> Copicseal 需要实现的完整产品需求
> 版本：v2.0 | 日期：2026-06-27

---

## 1. 产品定义

Copicseal 是一个以图片处理为核心的 Tauri 桌面应用，当前仅包含三个一级页面：

- Template
- Collage
- Settings

设计原则：

```txt
Preview First
Feature Oriented
No Project System
No Global Asset Workspace
Desktop Native (Tauri)
```

---

## 2. 全局布局

Template 采用以下布局：

```txt
┌────────┬────────────────────────────┬──────────────┐
│        │                            │              │
│ Nav    │       Workspace            │ Properties   │
│        │                            │              │
│        ├────────────────────────────┤              │
│        │         Assets             │              │
└────────┴────────────────────────────┴──────────────┘
```

Collage 将 Assets 移至左侧，改为文件夹直览双栏：

```txt
┌────────┬──────────┬─────────────┬──────────────┬──────────────┐
│        │ 文件夹树  │ 图片预览栏  │              │              │
│ Nav    │          │             │  Workspace   │ Properties   │
│        │          │             │              │              │
└────────┴──────────┴─────────────┴──────────────┴──────────────┘
```

### 2.1 Nav

- 固定宽度 `72px`
- 仅图标
- 鼠标悬浮显示 tooltip
- 永久显示
- 不可折叠
- 不允许顶部 Tab 导航

### 2.2 Workspace

- 是页面最重要区域
- 承担真实渲染
- 导出结果直接来自此区域
- 必须尽可能大

### 2.3 Properties

- 默认宽度 `320px`
- 可拖拽区间 `280px ~ 420px`
- 使用 `Accordion`

### 2.4 Assets

- Template 的 Assets 位于 Workspace 下方
- Collage 不使用该区域，改为左侧文件夹直览双栏（见 4.4）
- 只属于当前页面功能
- 不属于整个应用

---

## 3. Template 页面

路径：

```txt
/template
```

功能：

- 边框水印
- 模板渲染
- 批量导出

### 3.1 Template Workspace

渲染：

```tsx
<TemplateRuntime />
```

支持：

- 缩放
- `Fit`
- `50%`
- `100%`
- `200%`

### 3.2 Template Properties

#### Template Selector

模板列表示例：

```txt
Leica
Film
Minimal
Instagram
```

支持：

- 搜索
- 收藏
- 最近使用

#### Template Props

自动生成，来源为：

```ts
propsSchema
```

可覆盖内容例如：

- 边框宽度
- 字体
- 字体大小
- 颜色
- 圆角
- Logo

要求：

- 禁止手写模板专用表单
- 必须由 Schema 自动生成

#### 配置归属

模板、模板参数、背景与导出档位都属于单张照片：

- 编辑只影响当前照片，切换照片时面板切换到该照片自己的配置
- 「模板与参数」「背景」分别支持一键应用到其余照片
- 未编辑过的照片沿用框架默认配置

#### Export

包含：

- PNG
- JPG
- WEBP
- 质量
- 倍率
- 导出
- 批量导出

批量导出时每张图片按自己的模板、参数、背景与档位输出。

### 3.3 Template Assets

内容：

- 图片缩略图列表

支持：

- 拖拽导入
- 粘贴导入
- 文件夹导入
- 排序
- 点击切换当前预览图片
- 逐张删除

---

## 4. Collage 页面

路径：

```txt
/collage
```

核心原则：

Collage 与 Template 完全独立，禁止：

- 共享编辑器
- 共享布局逻辑
- 共享状态

仅共享：

- Export Pipeline
- Asset Infrastructure

### 4.1 Collage Workspace

渲染：

```tsx
<CollageCanvas />
```

支持：

- Grid Layout
- Free Layout

### 4.2 顶部工具栏

提供：

- `2 Grid`
- `3 Grid`
- `4 Grid`
- `6 Grid`
- `Auto Layout`
- `Free Layout`

### 4.3 Collage Properties

#### Layout

- 间距
- 边距
- 背景色
- 圆角
- 阴影

#### Selection

选中图片后显示：

- 缩放
- 位置
- 旋转
- 圆角

#### Export

与 Template 保持一致。

### 4.4 Collage Assets（文件夹直览）

由两个左侧栏组成。

#### 文件夹树

- 根节点：最近使用的文件夹、用户主目录、外接磁盘
- 点击按需展开子目录，不做递归扫描
- 选中目录后，图片预览栏加载该目录

#### 图片预览栏

- 缩略图网格展示目录内图片，按文件名排序
- 点击选中当前图片，选中态与画布、属性面板联动
- hover 显示「移除」：仅从列表隐藏，不删除本地文件
- 未打开文件夹时显示「打开文件夹」入口

#### 会话行为

- 记住上次打开的文件夹，重开自动恢复；路径失效时提示重新选择
- 提供手动刷新，重新枚举目录内容
- 缩略图按需生成，图片拖入画布时才复制进缓存

支持：

- 打开文件夹
- 浏览文件夹树
- 拖入拼图（拖到槽位即放入或替换）
- 移除条目（不删除本地文件）
- 点击切换当前图片

---

## 5. Settings 页面

路径：

```txt
/settings
```

设置中心布局：

```txt
┌──────────────────────────────────────┐
│ Settings                             │
├──────────────────────────────────────┤
│ General                              │
│ Template                             │
│ Collage                              │
│ Export                               │
│ Cache                                │
│ About                                │
└──────────────────────────────────────┘
```

### 5.1 General

- 主题
- 语言
- 启动页
- 默认导出目录（由当前平台支持时提供）
- 自动更新（仅桌面端支持）

### 5.2 Template

- 默认模板
- 默认字体
- 默认边框宽度
- 默认背景颜色
- 默认 EXIF 格式

### 5.3 Collage

- 默认布局
- 默认间距
- 默认背景色
- 默认圆角

### 5.4 Export

- 默认格式
- PNG
- JPG
- WEBP
- 默认倍率
- 默认质量

---

## 6. 导出要求

- 导出结果必须来自当前 Workspace
- Template 与 Collage 共享导出基础设施
- 支持 PNG / JPG / WEBP
- 支持质量与倍率设置
- 支持批量导出
- 导出直接写入配置的导出目录

---

## 7. 存储与状态要求

- 不引入项目系统
- 不引入全局素材工作区
- Template 与 Collage 分别维护各自的素材与状态
- Collage 记住当前打开的文件夹与最近打开的文件夹列表（轻量状态持久化）
- 仅默认配置、收藏、最近使用、缓存索引进入持久化
- 业务层通过统一 Platform Contract 访问图片、文件、存储和系统能力，不直接调用宿主 API
