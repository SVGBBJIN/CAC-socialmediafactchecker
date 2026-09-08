import { useEffect, useRef, useState } from "react";
import "./VideoPlayer.css";

/** Seconds → "M:SS". `public/timestamps.js` owns the same formatting in the product. */
function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export interface VideoMarker {
  /** Seconds into the clip. */
  time: number;
  /** The chip's own label, e.g. "0:08" — falls back to the formatted time. */
  label?: string;
}

export interface VideoPlayerProps {
  src: string;
  poster?: string;
  /** One tick per claim window on the scrub track. */
  markers?: VideoMarker[];
  /** Set to a time in seconds to seek there and play — how a timestamp chip drives the
   * player. Re-set to the same value won't re-seek; bump it or pass a fresh object. */
  seekTo?: number | null;
  onTimeUpdate?: (seconds: number) => void;
  onPlayingChange?: (playing: boolean) => void;
}

/**
 * The clip under examination, with the app's own chrome rather than the browser's. The
 * player is muted by default because that is the only way autoplay is allowed; the product
 * adds an unmute button to this bar for that reason.
 */
export function VideoPlayer({ src, poster, markers, seekTo, onTimeUpdate, onPlayingChange }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>();
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (seekTo == null || !videoRef.current) return;
    videoRef.current.currentTime = seekTo;
    void videoRef.current.play();
  }, [seekTo]);

  useEffect(() => () => clearTimeout(hideTimer.current), []);

  /** Chrome shows on interaction and hides itself again a couple of seconds later. */
  const wake = () => {
    setActive(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setActive(false), 2200);
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play();
    else video.pause();
    wake();
  };

  const seekFromClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    if (!video || !duration) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    video.currentTime = ratio * duration;
    wake();
  };

  const pct = duration ? (current / duration) * 100 : 0;

  return (
    <div className={`video-player${active || !playing ? " is-active" : ""}`} onMouseMove={wake}>
      <video
        ref={videoRef}
        src={src}
        poster={poster}
        playsInline
        muted
        loop
        onPlay={() => {
          setPlaying(true);
          onPlayingChange?.(true);
        }}
        onPause={() => {
          setPlaying(false);
          onPlayingChange?.(false);
        }}
        onTimeUpdate={(e) => {
          setCurrent(e.currentTarget.currentTime);
          onTimeUpdate?.(e.currentTarget.currentTime);
        }}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onClick={togglePlay}
      />

      <div className="vp-overlay" onClick={togglePlay}>
        <svg className="vp-mark" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="7.5" stroke="var(--accent)" strokeWidth="1.6" strokeDasharray="9 2 9 2" strokeLinecap="round" />
          <circle cx="12" cy="12" r="2" fill="var(--accent)" />
          <rect x="15.3" y="10.6" width="1.8" height="2.8" rx="0.5" fill="var(--accent-2)" />
        </svg>
        {playing ? null : (
          <span className="vp-play-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
          </span>
        )}
      </div>

      <div className="vp-bar" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="vp-btn" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause" : "Play"}>
          {playing ? (
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
          )}
        </button>
        <span className="vp-time">{formatTime(current)}</span>
        <div
          className="vp-scrub"
          role="slider"
          tabIndex={0}
          aria-label="Seek, and jump to a claim"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(current)}
          onClick={seekFromClick}
          onMouseDown={wake}
        >
          <div className="vp-scrub-track">
            <div className="vp-scrub-fill" style={{ width: `${pct}%` }} />
            {duration
              ? markers?.map((marker) => (
                  <button
                    key={marker.time}
                    type="button"
                    className="vp-marker"
                    style={{ left: `${(marker.time / duration) * 100}%` }}
                    title={marker.label ?? formatTime(marker.time)}
                    aria-label={`Jump to ${marker.label ?? formatTime(marker.time)}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (videoRef.current) videoRef.current.currentTime = marker.time;
                      wake();
                    }}
                  />
                ))
              : null}
            <div className="vp-scrub-thumb" style={{ left: `${pct}%` }} />
          </div>
        </div>
        <span className="vp-time vp-duration">{formatTime(duration)}</span>
      </div>
    </div>
  );
}
