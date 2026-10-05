import {
  createContext,
  type FC,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
} from 'react';
import { releaseSessionAssets, trackSessionAssets } from '@/platform/services/asset-service';
import { type ImportProgressSnapshot, processDroppedFiles } from '@/shared/lib/import-photo';
import type { ImportedPhoto } from '@/shared/types/photo';

type PhotoImportSource = 'drop';

interface PhotoImportState {
  active: boolean;
  source: PhotoImportSource | null;
  current: number;
  total: number;
  currentName: string | null;
}

interface PhotoContextValue {
  photos: ImportedPhoto[];
  currentIndex: number;
  currentPhoto: ImportedPhoto | null;
  isDraggingOver: boolean;
  importState: PhotoImportState;
  addPhotos: (photos: ImportedPhoto[]) => void;
  removePhoto: (id: string) => void;
  replacePhoto: (id: string, nextPhoto: ImportedPhoto) => void;
  setCurrentIndex: (index: number) => void;
  importViaDrop: (files: FileList | File[]) => Promise<void>;
}

export const PhotoContext = createContext<PhotoContextValue | null>(null);

interface PhotoProviderProps {
  children: ReactNode;
  /**
   * 宿主功能页是否可见。
   *
   * 素材会话已上提到应用层（全局唯一一份），而功能页仍常驻挂载，因此必须显式
   * 区分「挂载」与「激活」：宿主不可见时不接管全局拖放与粘贴，否则后台功能会
   * 抢走前台操作（例如在设置页拖入图片却被素材库静默收下）。
   */
  active?: boolean;
}

/**
 * 全局素材会话：应用内唯一一份照片列表。
 *
 * 边框水印与拼图共用它——切换功能时带着同一批照片走，文件来源面板点选的图片
 * 也进这里。拖放、粘贴与按路径懒导入都写入同一份会话。
 */
export const PhotoProvider: FC<PhotoProviderProps> = ({ children, active = true }) => {
  const sessionId = useId();
  const [photos, setPhotos] = useState<ImportedPhoto[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [importState, setImportState] = useState<PhotoImportState>({
    active: false,
    source: null,
    current: 0,
    total: 0,
    currentName: null,
  });

  // 登记当前素材为「正在使用」：设置页清理缓存时据此保留它们的本地副本，
  // 否则内存里的素材会指向已删除的文件（预览空白、导出失败）
  useEffect(() => {
    trackSessionAssets(
      sessionId,
      photos.map((photo) => photo.path),
    );
  }, [photos, sessionId]);

  useEffect(() => () => releaseSessionAssets(sessionId), [sessionId]);

  const addPhotos = useCallback((newPhotos: ImportedPhoto[]) => {
    setPhotos((prev) => [...prev, ...newPhotos]);
  }, []);

  const updatePhoto = useCallback((nextPhoto: ImportedPhoto) => {
    setPhotos((prev) =>
      prev.map((photo) => (photo.id === nextPhoto.id ? { ...photo, ...nextPhoto } : photo)),
    );
  }, []);

  const removePhoto = useCallback((id: string) => {
    setPhotos((prev) => {
      const idx = prev.findIndex((p) => p.id === id);
      const next = prev.filter((p) => p.id !== id);
      if (idx !== -1 && next.length > 0) {
        setCurrentIndex(Math.min(idx, next.length - 1));
      }
      return next;
    });
  }, []);

  const replacePhoto = useCallback((id: string, nextPhoto: ImportedPhoto) => {
    setPhotos((prev) =>
      prev.map((photo) =>
        photo.id === id
          ? {
              ...nextPhoto,
              id,
            }
          : photo,
      ),
    );
  }, []);

  const startImport = useCallback((source: PhotoImportSource) => {
    setImportState({
      active: true,
      source,
      current: 0,
      total: 0,
      currentName: null,
    });
  }, []);

  const updateImportProgress = useCallback(
    (source: PhotoImportSource, progress: ImportProgressSnapshot) => {
      setImportState({
        active: progress.current < progress.total,
        source,
        current: progress.current,
        total: progress.total,
        currentName: progress.currentName ?? null,
      });
    },
    [],
  );

  const finishImport = useCallback((source: PhotoImportSource) => {
    setImportState((prev) => ({
      active: false,
      source,
      current: prev.current,
      total: prev.total,
      currentName: prev.currentName,
    }));
  }, []);

  const importViaDrop = useCallback(
    async (files: FileList | File[]) => {
      startImport('drop');
      const result = await processDroppedFiles(files, {
        onProgress: (progress) => updateImportProgress('drop', progress),
        onPhotoImported: (photo) => addPhotos([photo]),
        onPhotoUpdated: updatePhoto,
      });
      if (!result.length) {
        finishImport('drop');
        return;
      }
      finishImport('drop');
    },
    [addPhotos, finishImport, startImport, updateImportProgress, updatePhoto],
  );

  useEffect(() => {
    // 宿主功能页不可见时不监听文件拖放：页面常驻挂载，否则后台功能会响应前台的拖入。
    if (!active) {
      setIsDraggingOver(false);
      return;
    }

    // 关闭 Tauri dragDropEnabled 后原生 onDragDropEvent 不再触发（该开关的语义就是
    // 「原生拖放开 = DOM 拖放关」），Finder 拖入改走标准 DOM 事件。
    // 只认 Files 类型：画布内部的图片拖拽由槽位自行处理，这里不拦截。
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;

    const handleDragEnter = (event: DragEvent) => {
      if (!hasFiles(event)) {
        return;
      }
      event.preventDefault();
      setIsDraggingOver(true);
    };

    const handleDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) {
        return;
      }
      // 不阻止默认行为就不会触发 drop，内嵌 WebView 会按默认行为打开该文件
      event.preventDefault();
    };

    const handleDragLeave = (event: DragEvent) => {
      // relatedTarget 为空表示指针离开窗口
      if (event.relatedTarget === null) {
        setIsDraggingOver(false);
      }
    };

    const handleDrop = (event: DragEvent) => {
      const files = event.dataTransfer?.files;
      if (!files?.length) {
        return;
      }
      event.preventDefault();
      setIsDraggingOver(false);
      // 没有专门的落点区域：任何位置拖入都进全局素材会话
      void importViaDrop(files);
    };

    window.addEventListener('dragenter', handleDragEnter);
    window.addEventListener('dragover', handleDragOver);
    window.addEventListener('dragleave', handleDragLeave);
    window.addEventListener('drop', handleDrop);

    return () => {
      window.removeEventListener('dragenter', handleDragEnter);
      window.removeEventListener('dragover', handleDragOver);
      window.removeEventListener('dragleave', handleDragLeave);
      window.removeEventListener('drop', handleDrop);
    };
  }, [active, importViaDrop]);

  useEffect(() => {
    // 粘贴与拖放同理：只在宿主功能页可见时接管，避免后台功能抢同一个事件。
    if (!active) {
      return;
    }

    const handlePaste = async (event: ClipboardEvent) => {
      const files = event.clipboardData?.files;
      if (files && files.length > 0) {
        event.preventDefault();
        await importViaDrop(files);
      }
    };

    window.addEventListener('paste', handlePaste);

    return () => {
      window.removeEventListener('paste', handlePaste);
    };
  }, [active, importViaDrop]);

  const currentPhoto = photos[currentIndex] ?? null;

  // value 必须记忆：它是全部消费方的重渲染开关。不记忆的话，只要 Provider 因
  // 自身状态或上层重渲染而重渲一次，value 就换新对象，两页素材、画布与面板
  // 会跟着全部重渲一遍，哪怕它们读的字段一个都没变。
  const value = useMemo(
    () => ({
      photos,
      currentIndex,
      currentPhoto,
      isDraggingOver,
      importState,
      addPhotos,
      removePhoto,
      replacePhoto,
      setCurrentIndex,
      importViaDrop,
    }),
    [
      photos,
      currentIndex,
      currentPhoto,
      isDraggingOver,
      importState,
      addPhotos,
      removePhoto,
      replacePhoto,
      importViaDrop,
    ],
  );

  return <PhotoContext.Provider value={value}>{children}</PhotoContext.Provider>;
};
