import { useState } from 'react';
import { CheckIcon, MapPinIcon } from './icons.jsx';

const ERROR_MESSAGES = {
  1: 'Location access is blocked. Allow location for this site in your browser settings, then try again.',
  2: "Your location isn't available right now. Check that location services are turned on.",
  3: 'Finding your location took too long. Please try again.',
};

/** Captures the patient's coordinates with the browser's Geolocation API. */
export default function LocationField({ location, onChange }) {
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);

  const locate = () => {
    if (!('geolocation' in navigator)) {
      setError("This browser can't share your location.");
      return;
    }

    setStatus('locating');
    setError(null);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setStatus('idle');
        onChange({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
        });
      },
      (geoError) => {
        setStatus('idle');
        setError(ERROR_MESSAGES[geoError.code] ?? 'We could not get your location. Please try again.');
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  };

  if (location) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-md border border-gray-200 px-3 py-3">
        <div className="flex items-center gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-emerald-50 text-emerald-700">
            <CheckIcon />
          </span>
          <div>
            <p className="text-sm font-medium text-gray-900">Location added</p>
            <p className="text-sm text-gray-500">
              {location.accuracy ? `Accurate to about ${Math.round(location.accuracy)} m` : 'Ready to search'}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={locate}
          disabled={status === 'locating'}
          className="rounded-md px-2 py-1 text-sm font-medium text-gray-900 hover:bg-gray-100 disabled:text-gray-400"
        >
          {status === 'locating' ? 'Updating...' : 'Update'}
        </button>
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={locate}
        disabled={status === 'locating'}
        className="flex w-full items-center justify-center gap-2 rounded-md border border-gray-300 bg-white px-4 py-3 font-medium text-gray-900 hover:bg-gray-50 disabled:cursor-wait disabled:text-gray-500"
      >
        <MapPinIcon className="size-5 text-gray-500" />
        {status === 'locating' ? 'Getting your location...' : 'Get current location'}
      </button>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
