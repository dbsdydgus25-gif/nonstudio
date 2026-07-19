'use client';

/**
 * ZoomableImage — 결과 이미지를 확대/이동하며 재질·디테일을 살펴보는 뷰어.
 * (2026-07-19) 다운로드 전에 원단 질감을 하나하나 확대해서 확인하고 싶다는 요청 반영.
 * - 마우스 휠(또는 트랙패드 핀치): 커서 위치 기준으로 확대/축소
 * - 확대 상태에서 드래그: 이동(패닝)
 * - 더블클릭: 그 지점 기준 1배 ↔ 2.5배 토글
 * - 우하단 버튼: 축소 / 배율 / 확대 / 원래대로
 * 라이트박스(전체화면 어두운 배경) 안에 넣는 것을 전제로 하며, 컨테이너를 꽉 채운다.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';

const MIN_SCALE = 1;
const MAX_SCALE = 6;

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

export function ZoomableImage({ src, alt = '' }: { src: string; alt?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const dragRef = useRef<{ startX: number; startY: number; baseTx: number; baseTy: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const reset = useCallback(() => {
    setScale(1);
    setTx(0);
    setTy(0);
  }, []);

  // src가 바뀌면(다른 이미지 열림) 배율 초기화
  useEffect(() => {
    reset();
  }, [src, reset]);

  // 커서 지점을 고정한 채 배율을 바꾼다. cx/cy는 컨테이너 중심 기준 좌표(transform-origin center).
  const zoomAt = useCallback(
    (nextScaleRaw: number, cx: number, cy: number) => {
      setScale((prevScale) => {
        const nextScale = clamp(nextScaleRaw, MIN_SCALE, MAX_SCALE);
        if (nextScale === MIN_SCALE) {
          setTx(0);
          setTy(0);
          return MIN_SCALE;
        }
        setTx((prevTx) => cx - ((cx - prevTx) / prevScale) * nextScale);
        setTy((prevTy) => cy - ((cy - prevTy) / prevScale) * nextScale);
        return nextScale;
      });
    },
    [],
  );

  const relToCenter = (clientX: number, clientY: number) => {
    const el = containerRef.current;
    if (!el) return { cx: 0, cy: 0 };
    const r = el.getBoundingClientRect();
    return { cx: clientX - r.left - r.width / 2, cy: clientY - r.top - r.height / 2 };
  };

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const { cx, cy } = relToCenter(e.clientX, e.clientY);
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      zoomAt(scale * factor, cx, cy);
    },
    [scale, zoomAt],
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const { cx, cy } = relToCenter(e.clientX, e.clientY);
      zoomAt(scale > 1 ? 1 : 2.5, cx, cy);
    },
    [scale, zoomAt],
  );

  const handleMouseDown = (e: React.MouseEvent) => {
    if (scale <= 1) return;
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startY: e.clientY, baseTx: tx, baseTy: ty };
    setIsDragging(true);
  };

  useEffect(() => {
    if (!isDragging) return;
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setTx(d.baseTx + (e.clientX - d.startX));
      setTy(d.baseTy + (e.clientY - d.startY));
    };
    const onUp = () => {
      dragRef.current = null;
      setIsDragging(false);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [isDragging]);

  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <div
      ref={containerRef}
      onWheel={handleWheel}
      onDoubleClick={handleDoubleClick}
      onMouseDown={handleMouseDown}
      onClick={stop}
      className="relative w-full h-full overflow-hidden flex items-center justify-center select-none"
      style={{ cursor: scale > 1 ? (isDragging ? 'grabbing' : 'grab') : 'zoom-in' }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        draggable={false}
        className="max-w-full max-h-[90vh] object-contain rounded-lg"
        style={{
          transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
          transformOrigin: 'center center',
          transition: isDragging ? 'none' : 'transform 0.12s ease-out',
          willChange: 'transform',
        }}
      />

      {/* 배율 컨트롤 */}
      <div
        onClick={stop}
        onDoubleClick={stop}
        className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-black/70 backdrop-blur-sm rounded-full px-1.5 py-1.5 text-white"
      >
        <button
          onClick={() => zoomAt(scale / 1.4, 0, 0)}
          className="w-8 h-8 rounded-full hover:bg-white/15 flex items-center justify-center text-lg leading-none"
          title="축소"
        >
          −
        </button>
        <button
          onClick={reset}
          className="min-w-[52px] px-2 h-8 rounded-full hover:bg-white/15 text-xs font-medium tabular-nums"
          title="원래 크기로"
        >
          {Math.round(scale * 100)}%
        </button>
        <button
          onClick={() => zoomAt(scale * 1.4, 0, 0)}
          className="w-8 h-8 rounded-full hover:bg-white/15 flex items-center justify-center text-lg leading-none"
          title="확대"
        >
          +
        </button>
      </div>

      <div className="absolute top-4 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-black/50 text-white/80 text-[11px] tracking-wide pointer-events-none">
        휠·＋/－로 확대, 드래그로 이동, 더블클릭 토글
      </div>
    </div>
  );
}
