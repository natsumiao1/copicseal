# 10 — 拼图开发清单

> 基于 2026-06-27 重制版产品文档
> 目标：独立完成 Collage 页面，不复用 Template 编辑状态与页面逻辑
> 状态：按 2026-10-03 实现情况勾选，未完成项附现状说明

---

## 1. 页面骨架

- [x] 创建 `/collage` 页面入口（`src/app/routes.ts`）
- [x] 接入统一三栏业务布局（`shared/layouts/business-workbench`）
- [x] 建立 `Collage Preview`
- [x] 建立 `Collage Assets`
- [x] 建立 `Properties` 面板

---

## 2. 预览与画布

- [x] 创建 `<CollageCanvas />`
- [x] 保证 Workspace 为真实渲染区域（导出快照取 `previewRef` 节点）
- [x] 建立从画布到导出的稳定链路（`prepareElementForSnapshot` → `exportSingle`）
- [x] 支持 Grid Layout
- [x] 支持 Free Layout

---

## 3. 顶部布局工具栏

- [x] 支持 `2 Grid`
- [x] 支持 `3 Grid`
- [x] 支持 `4 Grid`
- [x] 支持 `6 Grid`
- [x] 支持 `Auto Layout`
- [x] 支持 `Free Layout`
- [x] 支持 `布局库`：弹窗展示 `layouts.ts` 全部 54 种预设，按图片数量分组、带槽位缩略图

---

## 4. Assets 能力

- [x] 支持图片导入（对话框 + 拖入文件）
- [ ] 支持拖入拼图 —— 素材卡标了 `draggable` 但从未 `setData('text/copicseal-photo-id')`，
  画布侧读不到数据，实际不生效，目前只能点空槽填充（见 docs/13 C2）
- [ ] 支持排序 —— 素材区无任何排序交互；自由布局的层叠顺序即素材顺序，无法调整
- [x] 支持替换图片
- [x] 支持删除图片

---

## 5. Layout 面板

- [x] 支持间距
- [x] 支持边距
- [x] 支持背景色
- [x] 支持圆角
- [x] 支持阴影

---

## 6. Selection 面板

- [x] 选中图片后显示属性
- [x] 支持缩放
- [x] 支持位置调整
- [x] 支持旋转
- [x] 支持圆角

---

## 7. Export 面板

- [x] 支持 PNG
- [x] 支持 JPG
- [ ] 支持 WEBP —— 导出管线 `ExportFormat` 只有 `png | jpeg`
  （`src/shared/types/export.ts:8`），模板页同样只有这两档，属管线级缺口
- [x] 支持质量（标准 / 高清 / 超清三档 + JPEG 质量滑杆）
- [x] 支持倍率
- [x] 支持导出（导出当前 / 批量导出，直写配置的导出目录）

---

## 8. 独立性验收

- [x] 不共享 Template 编辑器（`features/collage` 无任何 `features/template` 引用）
- [x] 不共享 Template 布局逻辑（`collage/layouts.ts` 独立定义）
- [x] 不共享 Template 页面状态（两页各挂一份 `PhotoProvider`，拼图另有 `use-collage-store`）
- [x] 仅复用 Export Pipeline（`core/renderer`、`core/scheduler`、`platform` 导出服务）
- [x] 仅复用 Asset Infrastructure（`PhotoProvider`、`asset-service`、`import-photo`）
