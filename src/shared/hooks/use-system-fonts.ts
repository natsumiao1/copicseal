import { useEffect, useState } from 'react';
import { type FontInfo, platform } from '@/platform';

/**
 * 模块级缓存：系统字体枚举是一次性事实（进程生命周期内不变），
 * 多个组件（多选中的文字标注）各自挂载时不重复打宿主命令。
 */
let cachedFonts: FontInfo[] | null = null;
let pending: Promise<FontInfo[]> | null = null;

function loadFonts(): Promise<FontInfo[]> {
  if (cachedFonts) return Promise.resolve(cachedFonts);
  pending ??= platform.storage
    .listSystemFonts()
    .then((fonts) => {
      cachedFonts = fonts;
      return fonts;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

interface UseSystemFontsResult {
  fonts: FontInfo[];
  loading: boolean;
}

/**
 * 系统字体列表（按 family 名，宿主已排序去重）。
 *
 * 首次挂载发起枚举，成功后进程内缓存；失败时重置缓存允许下次重试，
 * 并通过 `console.error` 暴露（不吞错误）。
 */
export function useSystemFonts(): UseSystemFontsResult {
  const [fonts, setFonts] = useState<FontInfo[]>(cachedFonts ?? []);
  const [loading, setLoading] = useState(cachedFonts === null);

  useEffect(() => {
    if (cachedFonts) return;
    let alive = true;
    loadFonts()
      .then((list) => {
        if (alive) setFonts(list);
      })
      .catch((error: unknown) => {
        console.error('系统字体枚举失败', error);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  return { fonts, loading };
}
