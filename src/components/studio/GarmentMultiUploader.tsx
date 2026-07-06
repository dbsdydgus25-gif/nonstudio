'use client';

import React, { useRef } from 'react';

interface GarmentMultiUploaderProps {
  label: string;
  subLabel: string;
  images: string[];
  onImagesChange: (images: string[]) => void;
  presetButtonText?: string;
  onLoadPreset?: () => void;
  badgeText: string;
  badgeColor: string;
}

export function GarmentMultiUploader({
  label,
  subLabel,
  images,
  onImagesChange,
  presetButtonText,
  onLoadPreset,
  badgeText,
  badgeColor,
}: GarmentMultiUploaderProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const loadedImages: string[] = [];
    let processed = 0;

    Array.from(files).forEach((file) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        if (typeof reader.result === 'string') {
          loadedImages.push(reader.result);
        }
        processed++;
        if (processed === files.length) {
          onImagesChange([...images, ...loadedImages]);
        }
      };
      reader.readAsDataURL(file);
    });
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;

    const loadedImages: string[] = [];
    let processed = 0;

    const imageFiles = Array.from(files).filter(file => file.type.startsWith('image/'));
    if (imageFiles.length === 0) return;

    imageFiles.forEach((file) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        if (typeof reader.result === 'string') {
          loadedImages.push(reader.result);
        }
        processed++;
        if (processed === imageFiles.length) {
          onImagesChange([...images, ...loadedImages]);
        }
      };
      reader.readAsDataURL(file);
    });
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  const removeImage = (indexToRemove: number) => {
    onImagesChange(images.filter((_, idx) => idx !== indexToRemove));
  };

  const clearAll = () => {
    onImagesChange([]);
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
        {images.length > 0 && (
          <button
            onClick={clearAll}
            className="text-xs font-bold text-rose-600 hover:text-rose-700 bg-rose-50 hover:bg-rose-100 px-3 py-1.5 rounded-xl transition"
          >
            전체 비우기
          </button>
        )}
      </div>

      {/* 업로드 영역 및 썸네일 그리드 */}
      <div
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        className="flex-1 min-h-[300px] flex flex-col space-y-4"
      >
        {images.length > 0 ? (
          <div className="grid grid-cols-3 gap-3 p-1 overflow-y-auto max-h-[340px]">
            {images.map((img, idx) => (
              <div key={idx} className="group/item relative aspect-square rounded-xl overflow-hidden border border-gray-200 bg-white">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img}
                  alt={`Garment image ${idx + 1}`}
                  className="w-full h-full object-cover"
                />
                <button
                  type="button"
                  onClick={() => removeImage(idx)}
                  className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/70 text-white flex items-center justify-center text-xs hover:bg-rose-500 transition opacity-0 group-hover/item:opacity-100"
                >
                  ✕
                </button>
              </div>
            ))}

            {/* 그리드 내 추가 업로드 버튼 */}
            {images.length < 9 && (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="aspect-square rounded-xl border border-dashed border-gray-300 hover:border-amber-400 flex flex-col items-center justify-center gap-1.5 text-gray-400 hover:text-amber-600 hover:bg-amber-50/50 transition"
              >
                <span className="text-xl">+</span>
                <span className="text-[10px] font-bold">추가 추가</span>
              </button>
            )}
          </div>
        ) : (
          <div
            onClick={() => fileInputRef.current?.click()}
            className="flex-1 rounded-2xl border-2 border-dashed border-gray-300 hover:border-amber-400 bg-white cursor-pointer hover:bg-amber-50/30 flex flex-col items-center justify-center text-center p-6 space-y-4 transition"
          >
            <div className="w-16 h-16 rounded-3xl bg-gray-50 border border-gray-200 flex items-center justify-center mx-auto text-3xl group-hover:scale-110 transition duration-300">
              👕
            </div>
            <div>
              <p className="text-sm font-bold text-gray-700 mb-1">
                클릭하거나 이미지를 여기로 드래그하세요
              </p>
              <p className="text-xs text-gray-400">
                여러 장의 옷 사진 등록 가능 (정면, 측면, 소재 디테일 컷 등)
              </p>
            </div>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={handleFileChange}
          className="hidden"
        />
      </div>

      {/* 프리셋 / 빠른 등록 버튼 */}
      {presetButtonText && onLoadPreset && images.length === 0 && (
        <div className="mt-4 pt-4 border-t border-gray-200">
          <button
            type="button"
            onClick={onLoadPreset}
            className="w-full py-2.5 rounded-xl bg-amber-50 hover:bg-amber-100 border border-amber-200 text-amber-700 font-bold text-xs flex items-center justify-center gap-2 transition"
          >
            <span>⚡</span>
            <span>{presetButtonText}</span>
          </button>
        </div>
      )}
    </div>
  );
}
