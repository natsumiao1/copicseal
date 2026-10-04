import {
  createContext,
  type FC,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useState,
} from 'react';
import { releaseSessionAssets, trackSessionAssets } from '@/platform/services/asset-service';
import {
  type ImportProgressSnapshot,
  processDroppedFiles,
  selectPhotosFromDirectory,
  selectPhotosViaDialog,
} from '@/shared/lib/import-photo';
import { usePageActive } from '@/shared/providers/page-activity-provider';
import type { ImportedPhoto } from '@/shared/types/photo';

type PhotoImportSource = 'dialog' | 'directory' | 'drop';

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
  importViaDialog: () => Promise<void>;
  importViaDirectory: () => Promise<void>;
  importViaDrop: (files: FileList | File[]) => Promise<void>;
}

export const PhotoContext = createContext<PhotoContextValue | null>(null);

export const PhotoProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const pageActive = usePageActive();
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

  const importViaDialog = useCallback(async () => {
    startImport('dialog');
    const result = await selectPhotosViaDialog({
      onProgress: (progress) => updateImportProgress('dialog', progress),
      onPhotoImported: (photo) => addPhotos([photo]),
      onPhotoUpdated: updatePhoto,
    });
    if (!result.length) {
      finishImport('dialog');
      return;
    }
    finishImport('dialog');
  }, [addPhotos, finishImport, startImport, updateImportProgress, updatePhoto]);

  const importViaDirectory = useCallback(async () => {
    startImport('directory');
    const result = await selectPhotosFromDirectory({
      onProgress: (progress) => updateImportProgress('directory', progress),
      onPhotoImported: (photo) => addPhotos([photo]),
      onPhotoUpdated: updatePhoto,
    });
    if (!result.length) {
      finishImport('directory');
      return;
    }
    finishImport('directory');
  }, [addPhotos, finishImport, startImport, updateImportProgress, updatePhoto]);

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
    // 隐藏页不再监听文件拖放：页面常驻挂载后，否则两个功能页会同时响应同一次拖入。
    if (!pageActive) {
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
      // 空态 CoDropZone 会 stopPropagation 并自行导入，这里兜住其余区域
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
  }, [importViaDrop, pageActive]);

  const currentPhoto = photos[currentIndex] ?? null;

  return (
    <PhotoContext.Provider
      value={{
        photos,
        currentIndex,
        currentPhoto,
        isDraggingOver,
        importState,
        addPhotos,
        removePhoto,
        replacePhoto,
        setCurrentIndex,
        importViaDialog,
        importViaDirectory,
        importViaDrop,
      }}
    >
      {children}
    </PhotoContext.Provider>
  );
};
