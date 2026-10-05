import { useEffect } from 'react';
import { useFileSourceStore } from '@/shared/store/use-file-source-store';
import { useFilterStore } from '@/shared/store/use-filter-store';

/**
 * 标签数据加载：当前目录的图片枚举就绪后，批量读取 XMP 星级 / 颜色标签。
 *
 * 筛选器的星级与标签区要显示每个取值的数量，因此标签需要在目录就绪时就
 * 常驻加载，而不是等条件生效才读；结果按目录缓存在筛选 store 里，同一目录
 * 只读一次盘（每个文件最多读 1MB 头部）。
 *
 * 由 `CoFileSourceWorkbench` 挂载：两个功能页的文件来源是同一份全局状态，
 * 加载点必须独立于面板显隐（筛选器面板被关掉时条件可能仍然生效）。
 */
export function useSyncFilterTags() {
  const folderPath = useFileSourceStore((state) => state.folderPath);
  const entries = useFileSourceStore((state) => state.entries);
  const loadTags = useFilterStore((state) => state.loadTags);

  useEffect(() => {
    if (!folderPath || entries.length === 0) {
      return;
    }
    void loadTags(
      entries.map((entry) => entry.path),
      folderPath,
    );
  }, [entries, folderPath, loadTags]);
}
