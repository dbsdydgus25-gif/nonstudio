'use client';

import React, { useRef } from 'react';
import { fileToCompressedDataUrl } from '@/lib/client-image';

interface ImageUploaderProps {
  label: string;
  subLabel: string;
  image: string | null;
  onImageChange: (base64: string | null) => void;
  presetButtonText?: string;
  onLoadPreset?: () => void;
  badgeText: string;
  /** (구버전 호환) 컬러 뱃지 클래스 — 새 디자인에서는 무시하고 모노톤으로 통일 */
  badgeColor?: string;
}

export function ImageUploader({
  label,
  subLabel,
  image,
  onImageChange,
  presetButtonText,
  onLoadPreset,
  badgeText,
}: ImageUploaderProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    fileToCompressedDataUrl(file).then(onImageChange);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (!file || !file.type.startsWith('image/')) return;
    fileToCompressedDataUrl(file).then(onImageChange);
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  return (
    <div className="flex flex-col h-full bg-white border border-gray-200 rounded-2xl p-6 relative overflow-hidden hover:border-gray-300 transition group">
      {/* 뱃지 & 타이틀 */}
      <div className="flex items-start justify-between mb-5">
        <div>
          <span className="inline-block text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-400 border border-gray-200 px-2.5 py-1 rounded-md mb-2">
            {badgeText}
          </span>
          <h3 className="text-[15px] font-semibold text-gray-900 tracking-tight">{label}</h3>
          <p className="text-xs text-gray-400 mt-0.5">{subLabel}</p>
        </div>
        {image && (
          <button
            onClick={() => onImageChange(null)}
            className="text-[11px] font-medium text-gray-400 hover:text-gray-900 border border-gray-200 hover:border-gray-400 px-3 py-1.5 rounded-lg transition"
          >
            삭제
          </button>
        )}
      </div>

      {/* 업로드 박스 또는 미리보기 */}
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onClick={() => !image && fileInputRef.current?.click()}
        className={`flex-1 min-h-[340px] rounded-xl border flex flex-col items-center justify-center relative overflow-hidden transition ${
          image
            ? 'border-gray-100 bg-gray-50'
            : 'border-dashed border-gray-300 hover:border-gray-400 bg-gray-50/50 cursor-pointer'
        }`}
      >
        {image ? (
          <div className="relative w-full h-full flex items-center justify-center p-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={image}
              alt={label}
              className="max-h-[380px] w-auto object-contain rounded-lg animate-fade-in"
            />
            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="px-4 py-2 rounded-lg bg-white text-gray-900 font-medium text-xs tracking-wide transition hover:bg-gray-100"
              >
                사진 변경
              </button>
            </div>
          </div>
        ) : (
          <div className="text-center p-6 space-y-4">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
              className="w-10 h-10 mx-auto text-gray-300 group-hover:text-gray-400 transition"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="9" cy="9" r="2" />
              <path d="m21 15-3.5-3.5L6 23" />
            </svg>
            <div>
              <p className="text-[13px] font-medium text-gray-600 mb-1">
                클릭하거나 이미지를 이곳에 끌어다 놓으세요
              </p>
              <p className="text-[11px] text-gray-400">JPG · PNG · WEBP, 고해상도 권장</p>
            </div>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleFileChange}
          className="hidden"
        />
      </div>

      {/* 프리셋 / 빠른 등록 버튼 */}
      {presetButtonText && onLoadPreset && (
        <div className="mt-4 pt-4 border-t border-gray-100">
          <button
            type="button"
            onClick={onLoadPreset}
            className="w-full py-2.5 rounded-lg border border-gray-200 hover:border-gray-400 text-gray-600 hover:text-gray-900 font-medium text-xs tracking-wide transition"
          >
            {presetButtonText}
          </button>
        </div>
      )}
    </div>
  );
}
