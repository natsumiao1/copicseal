# 系统架构与数据模型

> 前端分层、平台 Contract、素材基础设施、持久化策略与核心数据模型。
> 需求见 [requirements.md](./requirements.md)，功能细则见 [features.md](./features.md)。

---

## 1. 前端边界与分层

前端实现范围全部限制在 `src/`：

```txt
src/
├── app/          # 应用初始化、路由与页面入口、全局布局壳层
├── features/     # template（边框水印）/ collage（拼图）/ settings（设置中心）
├── core/         # renderer（渲染稳定性）/ scheduler（导出调度）
├── platform/     # contracts（类型与接口）/ services（业务编排）/ providers/tauri（唯一宿主实现）
├── shared/       # components / hooks / layouts / lib / providers / store / types / ui
├── assets/       # 静态资源
└── main.tsx
```

| 层 | 职责 |
|------|------|
| `app` | 应用初始化、路由与页面入口、全局布局壳层 |
| `features` | 页面入口组件、页面状态、事件编排与面板内容组合 |
| `core` | 渲染稳定性控制、导出任务调度 |
| `shared` | 通用 UI、布局、全局状态（`shared/store`）与工具 |
| `platform` | 业务与宿主的唯一边界：`contracts` 提供稳定类型与接口，`services` 承载导入 / 导出 / 缓存等业务编排，`providers/tauri` 是唯一宿主实现 |

### 代码结构约束

- `shared/layouts` 只存放可复用布局组件，不判断当前业务页面，也不直接渲染 Template / Collage 的业务内容；通过 props 或 children 暴露 `header`、`panels`（文件夹 / 收藏夹 / 内容 / 预览区 / 调整区五块停靠面板）等插槽
- `shared/layouts/business-workbench` 为 dockview 停靠宿主，以 `panels` 插槽承载五块面板：每块一个 tab（标题 + ✕），可换位、四向分割、拖到中心合并为同组 tab，面板间 `4px` 细缝；默认布局里收藏夹与文件夹同组（第一栏两个 tab），旧布局缺收藏夹时首载补挂一次；布局持久化并跨页共享（`shared/store/use-workbench-dock-store.ts`）
- `features/template` 与 `features/collage` 提供页面入口组件，引用 `shared/layouts` 组装页面，而不是由布局层反向承载页面逻辑
- 功能选择（拼图 / 边框水印 / 设置）与「视图」菜单位于窗口顶部横条 `CoTopNav`，由 `app.tsx` 顶层挂载
- 底部素材条机制已移除，Template 与 Collage 共用同一停靠布局与同一份素材会话（`PhotoProvider` 全局一份，挂于 `app.tsx`，`/settings` 页不激活）

### Feature 独立原则

Collage 与 Template 完全独立，禁止共享编辑器、共享布局逻辑、共享状态；仅共享 Export Pipeline、Asset Infrastructure 与 EXIF Infrastructure（边界表见 [requirements.md](./requirements.md) §1）。

---

## 2. 平台边界（platform）

业务与宿主之间的唯一边界。产品只交付 Tauri 桌面形态，因此这里**没有宿主探测、没有 Provider 注册，也没有降级编排**：`platform` 单例由 Tauri 实现直接组装，宿主能力的增减只改 `providers/tauri` 内部实现。

```ts
export const platform = createPlatform(); // src/platform/platform.ts

await platform.files.listFolderImages(folderPath);
await platform.storage.getConfig();
await platform.export.exportSingle(node, options, sourcePath, context);
```

禁止在 `features/`、`features/template/runtime/` 或 `core/` 中直接调用 `invoke`、`window.__TAURI__` 等宿主 API；页面组件中不允许散落 `isTauri()` 或浏览器 API 分支。

### 2.1 能力域

```ts
export interface Platform {
  readonly assets: AssetServiceContract; // 导入与素材会话
  readonly export: ExportServiceContract; // 导出管线与任务
  readonly files: FileServiceContract; // 文件、目录枚举、直览缩略图与缓存
  readonly storage: StorageServiceContract; // 配置与系统字体
  readonly cache: CacheServiceContract; // 前端内存缓存
}
```

Contract 直接以本地路径等桌面数据描述操作（产品只有桌面形态，不做跨宿主的数据抽象）；`invoke`、Tauri API、编码与 I/O 等宿主细节只出现在 `providers/tauri`。

| 层 | 位置 | 职责 |
|------|------|------|
| Contract | `platform/contracts` | 定义操作语义与输入输出的数据类型 |
| Service | `platform/services` | 业务编排：导入流程、导出调度、缓存与配置读写 |
| 宿主实现 | `platform/providers/tauri` | 全应用唯一的 `invoke` 出口与 Tauri API 封装 |

Service 直接绑定 `providers/tauri` 的命令封装，两者之间不设中转层：唯一宿主下没有第二种实现可切换，
adapter 门面（`FileAdapter` / `StorageAdapter` / `platform-runtime`）只增加一层逐函数转发。
功能代码按需从 `@/platform` 引入这些封装，或统一走 `platform.*` 能力域。

### 2.2 错误语义

- 唯一宿主是 Tauri，不存在跨宿主选择性降级，也没有 `PLATFORM_NOT_IMPLEMENTED` / `PLATFORM_UNSUPPORTED` 这类降级错误码
- 解码、权限、参数、I/O 与存储错误必须原样上抛，不得静默重试或掩盖失败
- 没有能力预判机制（`platform.capabilities` 已移除）：界面按桌面端能力恒定展示，运行时意外直接以错误提示暴露

### 2.3 与预览、导出、缓存的关系

- Workspace 是预览与导出内容的唯一视觉来源，不维护另一套隐藏模板
- `snapDOM` 负责从稳定的 Workspace 生成渲染结果；Platform 负责后续编码与保存等宿主相关步骤
- HEIC/HIF 的快速预览可使用 JPEG preview，但最终导出不得只使用该 preview：导出应按需从原始素材生成临时高质量源，并在任务结束后清理或短期缓存
- 缓存实现可以不同，但缓存键、过期策略与用户可清理语义应保持一致

---

## 3. 素材基础设施

只提供底层能力，不提供素材中心页面。

**提供**：文件导入、粘贴导入、文件夹扫描与目录枚举（子目录、图片列表、磁盘根）、缩略图生成（含以原文件为源的直览缩略图）、懒导入（图片被使用时才复制进缓存）、预览 URL 管理、最近打开的文件夹记录、文件夹收藏（文件夹 + 收藏夹 + 内容三块停靠面板）、全局素材会话（应用内唯一一份照片列表）、缓存管理。

**不提供**：素材库页面（标签、评级、归档、项目化管理）、项目级素材归档。

### 3.1 文件系统与缓存

| 功能 | 说明 |
|------|------|
| 选择目录 | 平台层保留系统目录选择器能力；产品界面不提供入口，选目录走文件夹树导航 |
| 打开文件 | 使用系统默认程序打开；打开文件夹用于打开导出目录 |
| 目录枚举 | 列出子目录与图片文件路径，供文件夹树与内容面板使用，不复制原文件 |
| 直览缩略图 | 直接以原文件为源生成缩略图，按原路径 + mtime 哈希写入缓存 |
| 缩略图缓存 | 为内容面板提供快速展示 |
| 预览资源缓存 | 降低重复读取成本 |
| 主题色缓存 | 按图片缓存提取出的主题色，避免重复采样 |
| 最近文件夹 | 记录最近打开的目录，供文件夹树与会话恢复使用 |

通过 Tauri 访问用户明确授权的本地路径；导出直接写入目标目录，不提供浏览器下载降级。

### 3.2 数据库存储

SQLite 存储轻量配置与索引：General 设置、Template / Collage / Export 默认配置、模板收藏与最近使用、缓存索引。业务层只能通过 Storage Contract 访问。

---

## 4. 持久化策略

**持久化**：Settings 默认配置、模板收藏、模板最近使用、全局文件来源状态（当前文件夹、最近文件夹、收藏文件夹）与五块面板的停靠布局、缓存索引。

**不持久化为项目**：Template 会话编辑状态、Collage 会话编辑状态、全局工作区快照。

补充原则：

- Template 与 Collage 运行态状态不做项目化持久化
- 全局文件来源只持久化轻量状态，不含素材本体
- 模板收藏、最近使用等轻量状态可持久化
- 素材缩略图与缓存由基础设施统一管理

---

## 5. 数据模型

### 5.1 Template Asset（素材会话条目）

全局唯一（`PhotoProvider`），Template 与 Collage 共用同一份列表：

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | 唯一标识 |
| fileName | string | 原始文件名 |
| filePath | string | 本地文件路径 |
| previewUrl | string | 预览资源 |
| thumbnailUrl | string | 缩略图资源 |
| exif | object | EXIF 数据 |
| order | number | 资产排序 |
| selected | boolean | 是否选中 |

### 5.2 Template Session

页面级会话状态：

| 字段 | 类型 | 说明 |
|------|------|------|
| activeAssetId | string | 当前预览图片 |
| zoom | `fit` \| 50 \| 100 \| 200 | 预览缩放档位；`100` 表示照片按原始像素宽度显示 |

每张照片各持一份模板配置，彼此独立：

| 字段 | 类型 | 说明 |
|------|------|------|
| photoId | string | 归属的照片 |
| templateId | string | 该照片使用的模板 ID |
| templateProps | object | 该照片的模板参数，切换模板时重置为该模板的默认值 |
| background | object | 该照片的背景设置，同样随模板切换重置 |
| exportPresets | ExportPreset[] | 该照片的输出档位，至少一档 |

约束：

- 未编辑过的照片沿用框架默认配置（默认模板及其默认参数与背景），不写入任何条目；例外是纯色背景的主题色默认：选中一张纯色背景且颜色仍为默认值的照片时，会为它写入一次第一个主题色
- 该默认色只在浏览照片时写入，导出期间不改写配置：批量导出严格按每张照片已有的配置渲染
- 切换模板只影响当前照片；「模板与参数」「背景」分别支持一键应用到其余照片，参数与模板必须一起复制
- 素材被移除时其配置一并回收
- 运行态配置不做跨会话持久化（见 §4）

### 5.3 Template Definition

| 字段 | 类型 | 说明 |
|------|------|------|
| id / name | string | 模板 ID 与模板名 |
| tags | string[] | 搜索与分类标签 |
| favorite | boolean | 是否收藏 |
| recentUsedAt | string | 最近使用时间 |
| propsSchema | object | 该模板独有的可调参数描述 |
| componentKey | string | 运行时组件标识 |

#### propsSchema 字段

每个模板独立声明自己的可调参数，属性面板完全由它生成：

| 字段 | 类型 | 说明 |
|------|------|------|
| key / label | string | 参数键 / 展示名 |
| type | `number` \| `color` \| `select` \| `text` | 控件形态 |
| default | number \| string | 默认值 |
| min / max / step | number | 数值范围与步长，仅 `number` |
| options | { label, value }[] | 候选项，仅 `select` |

- 模板之间不共享参数集合，切换模板时参数重置为该模板的默认值
- 数值参数的取值是相对画布宽度的比例，不带单位

#### backgroundDefaults（模板背景默认值）

背景是框架级能力，模板只负责给出自己认为最佳的默认值，用户可在属性面板覆盖：

| 字段 | 类型 | 说明 |
|------|------|------|
| mode | `none` \| `color` \| `image` | 背景模式 |
| color | string | 纯色背景颜色 |
| blur / brightness | number | 模糊强度（相对画框宽度比例）/ 模糊图亮度 |
| paddingHorizontal / paddingVertical | number | 内边距，均以画框宽度为基准 |

- 字段按模式条件显示：颜色仅纯色模式可见，模糊与亮度仅照片模式可见，内边距在两种有背景的模式下都可见
- 纯色模式的颜色默认取自动提取的照片主题色（前 5 色按占比排序，会话内按图片缓存，不进配置），用户改过颜色后不再覆盖
- `image` 模式当前使用正在编辑的照片本身；自定义背景图预留字段，暂不实现

### 5.4 文件来源状态

内容面板以文件夹为单位展示的图片条目：

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | 唯一标识，取自文件路径，保证跨会话稳定（画布槽位引用它） |
| fileName / filePath | string | 文件名 / 本地路径 |
| size | number | 文件大小（字节） |
| thumbnailUrl | string \| null | 缩略图资源；尚未生成时为 `null` |

- 条目由目录枚举直接产生，不预先复制原文件；被点选或拖入使用时才执行缓存导入
- 从列表「移除」只在当前会话隐藏条目，不删除本地文件

全局文件来源状态：

| 字段 | 类型 | 说明 |
|------|------|------|
| folderPath | string \| null | 当前直览文件夹；持久化，`null` 表示未打开 |
| recentFolders | string[] | 最近打开的文件夹（新→旧，最多 10 条）；持久化 |
| favoriteFolders | string[] | 收藏的文件夹（新→旧，按路径去重，只收藏文件夹）；持久化，供收藏夹面板展示 |
| removedPaths | string[] | 本次会话从列表隐藏的路径；不持久化，换文件夹即清空 |

- 落地为 `shared/store/use-file-source-store.ts`（键 `copicseal-file-source-state`），由两个功能页共用；持久化载荷只挑已知字段合并，历史遗留字段读取时丢弃

### 5.5 停靠布局状态

| 字段 | 类型 | 说明 |
|------|------|------|
| layout | SerializedDockview \| null | 五块面板的布局（位置、尺寸、tab 归组、关闭状态；默认一行四栏，收藏夹与文件夹同栏两 tab）；持久化，键 `copicseal-dock-layout`，`null` 表示首次启动待构建 |
| favoritesSeeded | boolean | 收藏夹 tab 是否已并入布局；持久化，旧布局首载补挂一次后置位，之后显示与否完全以布局为准 |
| apis | Partial\<Record\<AppRoute, DockviewApi\>\> | 各功能页工作台的 dockview 实例；不持久化，顶栏「视图」菜单按当前路由取用 |

- 落地为 `shared/store/use-workbench-dock-store.ts`，两个功能页共享同一份布局
- 本页布局变化防抖回写 `layout`，再经订阅同步到另一页（序列化字符串比对防回环）
- 布局读取时做结构校验（面板 id / 组件名都在五块之内），损坏则回退默认一行四栏
- 旧版本保存的布局缺收藏夹 tab 时，首载由 `ensureFavoritesPanel` 并入文件夹组一次（`favoritesSeeded` 置位）
- 旧键 `folderCollapsed` / `contentCollapsed` 弃用，不迁移

### 5.6 Collage Session

| 字段 | 类型 | 说明 |
|------|------|------|
| layoutMode | `'grid' \| 'free'` | 布局模式 |
| layoutPreset | string | 当前布局预设 |
| canvasStyle | object | 间距、边距、背景、圆角、阴影 |
| items | object[] | 画布中的图片项 |
| selectedItemId | string | 当前选中图片项 |
| exportConfig | object | 导出配置 |

Collage Item：`id`、`assetId`、`x`、`y`、`width`、`height`、`scale`、`rotation`、`borderRadius`。

### 5.7 Export Config

| 字段 | 类型 | 说明 |
|------|------|------|
| presets | ExportPreset[] | 输出档位列表，至少一档 |
| outputDir | string | 输出目录 |
| preserveExif | boolean | 是否保留原图 EXIF |
| dpi | number | 分辨率元数据，不参与尺寸计算 |

ExportPreset：`id`、`fileName`（缺省表示按目标尺寸自动命名）、`format`（`png` \| `jpeg`，WebP 暂不支持）、`width`、`height`、`scale`、`quality`。字段语义见 [features.md](./features.md) §3.3，尺寸解算见 §3.4。

### 5.8 Settings Config

设置中心的配置项即 [requirements.md](./requirements.md) §7 列出的字段（General / Template / Collage / Export 四组），经 Storage Contract 持久化。
