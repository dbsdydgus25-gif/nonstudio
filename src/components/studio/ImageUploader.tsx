'use client';

import React, { useRef } from 'react';

interface ImageUploaderProps {
  label: string;
  subLabel: string;
  image: string | null;
  onImageChange: (base64: string | null) => void;
  presetButtonText?: string;
  onLoadPreset?: () => void;
  badgeText: string;
  badgeColor: string;
}

export function ImageUploader({
  label,
  subLabel,
  image,
  onImageChange,
  presetButtonText,
  onLoadPreset,
  badgeText,
  badgeColor,
}: ImageUploaderProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onloadend = () => {
      onImageChange(reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (!file || !file.type.startsWith('image/')) return;

    const reader = new FileReader();
    reader.onloadend = () => {
      onImageChange(reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  return (
    <div className="flex flex-col h-full bg-gray-50 border border-gray-200 rounded-3xl p-6 relative overflow-hidden hover:border-gray-300 transition group">
      {/* 뱃지 & 타이틀 */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <span
            className={`inline-block text-[10px] font-black uppercase tracking-wider px-2.5 py-1 rounded-full mb-1.5 ${badgeColor}`}
          >
            {badgeText}
          </span>
          <h3 className="text-base font-black text-gray-900">{label}</h3>
          <p className="text-xs text-gray-400">{subLabel}</p>
        </div>
        {image && (
          <button
            onClick={() => onImageChange(null)}
            className="text-xs font-bold text-rose-600 hover:text-rose-700 bg-rose-50 hover:bg-rose-100 px-3 py-1.5 rounded-xl transition"
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
        className={`flex-1 min-h-[340px] rounded-2xl border-2 border-dashed flex flex-col items-center justify-center relative overflow-hidden transition ${
          image
            ? 'border-transparent bg-gray-100'
            : 'border-gray-300 hover:border-violet-400 bg-white cursor-pointer hover:bg-violet-50/30'
        }`}
      >
        {image ? (
          <div className="relative w-full h-full flex items-center justify-center p-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={image}
              alt={label}
              className="max-h-[380px] w-auto object-contain rounded-xl shadow-lg animate-fade-in"
            />
            <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 flex items-center justify-center gap-3 transition">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="px-4 py-2 rounded-xl bg-white text-gray-900 font-bold text-xs shadow-lg hover:scale-105 transition"
              >
                📸 사진 변경하기
              </button>
            </div>
          </div>
        ) : (
          <div className="text-center p-6 space-y-4">
            <div className="w-16 h-16 rounded-3xl bg-gray-50 border border-gray-200 flex items-center justify-center mx-auto text-3xl group-hover:scale-110 transition duration-300">
              🖼️
            </div>
            <div>
              <p className="text-sm font-bold text-gray-700 mb-1">
                클릭하거나 이미지를 여기로 드래그하세요
              </p>
              <p className="text-xs text-gray-400">
                JPG, PNG, WEBP (고해상도 권장)
              </p>
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
        <div className="mt-4 pt-4 border-t border-gray-200">
          <button
            type="button"
            onClick={onLoadPreset}
            className="w-full py-2.5 rounded-xl bg-violet-50 hover:bg-violet-100 border border-violet-200 text-violet-700 font-bold text-xs flex items-center justify-center gap-2 transition"
          >
            <span>⚡</span>
            <span>{presetButtonText}</span>
          </button>
        </div>
      )}
    </div>
  );
}
