# 01 — 产品愿景与目标

## 产品定位

Copicseal（可图匠）是一个以图片处理为核心的 Tauri 桌面应用，当前聚焦三项能力：

1. 边框水印
2. 拼图
3. 设置中心

这不是通用设计软件，也不是素材管理平台。产品聚焦于“快速导入、即时预览、直接导出”的图片生产体验。

拼图以文件夹为工作单元：素材区直接浏览本地文件夹内容（文件夹树 + 图片预览栏），只有真正投入画布的图片才进入缓存。文件夹直览只替代“先导入后使用”的入口，不提供标签、评级、归档等素材管理能力。

产品只交付 Tauri 桌面形态，不再维护浏览器运行版本。图片处理、本地文件、存储与系统集成均由 Rust 侧提供；不再提供 Web Provider、浏览器降级路径或与之等价的伪实现。

---

## 核心目标

- 让用户围绕单张图或一组图快速生成可发布的结果
- 把真实预览作为主要交互中心，而不是表单或项目树
- 让 Template 与 Collage 成为两个互不干扰的独立功能域
- 通过统一导出管线输出稳定一致的最终图片
- 让业务功能只依赖统一的平台能力接口，而不绑定具体宿主

---

## 设计原则

```txt
Preview First
Feature Oriented
No Project System
No Global Asset Workspace
Desktop Native (Tauri)
```

### Preview First

- 中央 Workspace 是最重要区域
- 预览即真实渲染结果
- 导出直接取自 Workspace 渲染结果

### Feature Oriented

- 所有用户操作围绕页面功能组织
- Template、Collage、Settings 是唯一一级页面
- 页面内资产、属性、状态都服务于当前功能

### No Project System

- 不提供项目、文档、画布工程、工作区切换
- 不要求用户先创建项目再编辑
- 导入图片后即可开始处理

### No Global Asset Workspace

- 不存在应用级素材中心
- Template Assets 与 Collage Assets 分别归属于对应页面
- Collage 的文件夹直览仍归属于拼图页面，不构成全局素材中心
- 仅底层缓存、缩略图和文件访问能力可复用

### Desktop Native (Tauri)

- 产品只在 Tauri 桌面端运行与交付
- 平台 Contract 仍作为业务与宿主之间的唯一边界，但只注册 Tauri Provider
- 不再提供浏览器降级路径，也不伪造桌面能力的 Web 等价物
- 托盘、任意路径写入、自动更新等桌面能力按桌面语义直接实现

---

## 页面边界

### Template

- 单图边框水印
- 模板渲染
- props 驱动编辑
- 批量导出

### Collage

- 多图拼图
- 文件夹直览素材区（文件夹树 + 图片预览栏）
- Grid Layout
- Free Layout
- 批量导出

### Settings

- 跨平台行为与能力设置
- Template 默认行为
- Collage 默认行为
- Export 默认行为

---

## 成功标准

- 用户进入任一业务页面后，首先看到的是可工作的预览区
- 预览区、属性区、素材区各自职责清晰
- Template 与 Collage 可以独立演进，而不会互相污染状态或交互
- 用户不需要理解项目结构即可完成导入、编辑、导出
