import { useId, useState } from 'react';
import { CameraIcon } from './icons.jsx';

/**
 * A large dashed dropzone. On a phone, tapping it opens the rear camera; the
 * link underneath opens the photo library instead. On a desktop, the capture
 * hint is ignored and it opens a file picker, and photos can be dragged in.
 */
export default function PhotoPicker({ previewUrl, onSelect, onClear }) {
  const cameraId = useId();
  const galleryId = useId();
  const [dragging, setDragging] = useState(false);

  const handleFiles = (files) => {
    const file = files?.[0];
    if (file) onSelect(file);
  };

  const handleChange = (event) => {
    handleFiles(event.target.files);
    // Allow choosing the same file again after clearing it.
    event.target.value = '';
  };

  if (previewUrl) {
    return (
      <div className="overflow-hidden rounded-md border border-gray-200">
        <img src={previewUrl} alt="Your prescription" className="max-h-72 w-full bg-gray-100 object-contain" />
        <div className="flex items-center justify-between border-t border-gray-200 px-3 py-2">
          <span className="text-sm text-gray-500">Photo added</span>
          <button
            type="button"
            onClick={onClear}
            className="rounded-md px-2 py-1 text-sm font-medium text-gray-900 hover:bg-gray-100"
          >
            Replace
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <label
        htmlFor={cameraId}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          handleFiles(event.dataTransfer.files);
        }}
        className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-4 py-10 text-center transition-colors ${
          dragging ? 'border-emerald-600 bg-emerald-50' : 'border-gray-300 bg-gray-50 hover:border-gray-400'
        }`}
      >
        <CameraIcon className="size-8 text-gray-500" />
        <span className="font-medium text-gray-900">Take a photo of your prescription</span>
        <span className="text-sm text-gray-500">Make sure the medication names are clear and in focus</span>
      </label>
      <input
        id={cameraId}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleChange}
        className="sr-only"
      />

      <p className="mt-2 text-center text-sm text-gray-500">
        Already have a photo?{' '}
        <label htmlFor={galleryId} className="cursor-pointer font-medium text-emerald-700 underline-offset-2 hover:underline">
          Choose from your gallery
        </label>
      </p>
      <input id={galleryId} type="file" accept="image/*" onChange={handleChange} className="sr-only" />
    </div>
  );
}
