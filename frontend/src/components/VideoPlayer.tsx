import { Modal, message, Spin } from 'antd';
import { VideoCameraOutlined } from '@ant-design/icons';
import { useEffect, useRef, useState } from 'react';
import { fileApi } from '../api';

interface VideoPlayerProps {
  open: boolean;
  onClose: () => void;
  videoUrl: string;
  videoName: string;
  filePath?: string;
}

interface FileVersion {
  etag: string;
  lastModified: string;
  size: number;
}

export default function VideoPlayer({ open, onClose, videoUrl, videoName, filePath }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [checkingVersion, setCheckingVersion] = useState(false);
  const [resolvedUrl, setResolvedUrl] = useState(videoUrl);

  const getCacheKey = (url: string) => {
    return `video_cache_${url}`;
  };

  const getCachedVersion = (url: string): FileVersion | null => {
    try {
      const cached = localStorage.getItem(getCacheKey(url));
      return cached ? JSON.parse(cached) : null;
    } catch {
      return null;
    }
  };

  const setCachedVersion = (url: string, version: FileVersion) => {
    try {
      localStorage.setItem(getCacheKey(url), JSON.stringify(version));
    } catch {
      console.warn('Failed to cache version info');
    }
  };

  const checkVersionAndPlay = async () => {
    console.log('VideoPlayer: checkVersionAndPlay called');
    console.log('VideoPlayer: videoUrl:', videoUrl);
    console.log('VideoPlayer: filePath:', filePath);
    console.log('VideoPlayer: videoName:', videoName);
    
    if (!filePath) {
      console.log('VideoPlayer: filePath not provided, skipping version check');
      setResolvedUrl(videoUrl);
      return;
    }

    setCheckingVersion(true);
    try {
      const filename = videoName;
      const prefix = filePath.split('/').slice(0, -1).join('/');
      
      console.log('VideoPlayer: Calling checkVersion with:', { filename, prefix });
      const result = await fileApi.checkVersion(filename, prefix);
      
      console.log('VideoPlayer: Version check result:', JSON.stringify(result));
      
      if (result.code === 200 && result.data) {
        const serverVersion: FileVersion = {
          etag: result.data.etag,
          lastModified: result.data.lastModified,
          size: result.data.size,
        };
        
        const cachedVersion = getCachedVersion(videoUrl);
        
        console.log('VideoPlayer: Server ETag:', serverVersion.etag);
        console.log('VideoPlayer: Cached ETag:', cachedVersion?.etag);
        
        if (cachedVersion && cachedVersion.etag === serverVersion.etag) {
          console.log('VideoPlayer: Version unchanged, using cache');
          setResolvedUrl(videoUrl);
        } else {
          console.log('VideoPlayer: Version changed or no cache, forcing reload');
          const timestamp = Date.now();
          const urlWithTimestamp = videoUrl.includes('?') 
            ? `${videoUrl}&v=${timestamp}` 
            : `${videoUrl}?v=${timestamp}`;
          setResolvedUrl(urlWithTimestamp);
          setCachedVersion(videoUrl, serverVersion);
        }
      } else {
        console.log('VideoPlayer: Version check failed, using original URL');
        setResolvedUrl(videoUrl);
      }
    } catch (error) {
      console.error('VideoPlayer: Version check error:', error);
      setResolvedUrl(videoUrl);
    } finally {
      setCheckingVersion(false);
    }
  };

  useEffect(() => {
    if (open) {
      checkVersionAndPlay();
    }
  }, [open]);

  useEffect(() => {
    if (!checkingVersion && resolvedUrl && videoRef.current) {
      videoRef.current.load();
    }
  }, [resolvedUrl, checkingVersion]);

  const handleError = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const video = e.currentTarget;
    console.error('Video error:', video.error);
    console.error('Video URL:', resolvedUrl);
    if (video.error) {
      message.error(`视频加载失败: ${video.error.message}`);
    } else {
      message.error('视频加载失败，请检查网络或文件是否存在');
    }
  };

  const handleLoad = () => {
    console.log('Video loaded successfully:', resolvedUrl);
  };

  return (
    <Modal
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <VideoCameraOutlined />
          <span>{videoName}</span>
        </div>
      }
      open={open}
      onCancel={onClose}
      width={800}
      footer={null}
      destroyOnClose
    >
      <div style={{ marginBottom: 12, fontSize: '12px', color: '#999', wordBreak: 'break-all' }}>
        {checkingVersion ? (
          <span>正在检查版本...</span>
        ) : (
          <span>视频URL: {resolvedUrl}</span>
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'center', backgroundColor: '#000', borderRadius: '8px', overflow: 'hidden', minHeight: '400px', alignItems: 'center' }}>
        {checkingVersion ? (
          <Spin size="large" tip="检查版本中..." />
        ) : (
          <video
            ref={videoRef}
            src={resolvedUrl}
            controls
            style={{ width: '100%', maxHeight: '500px' }}
            playsInline
            preload="metadata"
            onError={handleError}
            onLoadedMetadata={handleLoad}
          >
            您的浏览器不支持视频播放。
          </video>
        )}
      </div>
    </Modal>
  );
}