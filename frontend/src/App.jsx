import { useEffect, useState } from 'react';
import PhotoPicker from './components/PhotoPicker.jsx';
import LocationField from './components/LocationField.jsx';
import PhoneField from './components/PhoneField.jsx';
import ProcessingView from './components/ProcessingView.jsx';
import ResultView from './components/ResultView.jsx';
import { AlertIcon } from './components/icons.jsx';
import { submitPrescription } from './lib/api.js';
import { shrinkImage } from './lib/image.js';
import { isValidNigerianPhone } from './lib/format.js';

function Step({ number, title, children }) {
  return (
    <div>
      <h2 className="mb-3 flex items-center gap-2 font-bold text-gray-900">
        <span className="flex size-6 items-center justify-center rounded-md bg-gray-900 text-xs text-white">{number}</span>
        {title}
      </h2>
      {children}
    </div>
  );
}

export default function App() {
  const [view, setView] = useState('form');
  const [photo, setPhoto] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [location, setLocation] = useState(null);
  const [phone, setPhone] = useState('');
  const [stage, setStage] = useState('uploading');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!photo) {
      setPreviewUrl(null);
      return undefined;
    }
    const url = URL.createObjectURL(photo);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [view]);

  const phoneValid = isValidNigerianPhone(phone);
  const missing = [!photo && 'a photo', !location && 'your location', !phoneValid && 'your phone number'].filter(Boolean);
  const ready = missing.length === 0;

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!ready) return;

    setError(null);
    setStage('uploading');
    setView('processing');

    try {
      const data = await submitPrescription({
        photo: await shrinkImage(photo),
        phone,
        latitude: location.latitude,
        longitude: location.longitude,
        onStage: setStage,
      });
      setResult(data);
      setView('result');
    } catch (submitError) {
      setError(submitError.message);
      setView('form');
    }
  };

  const retakePhoto = () => {
    setPhoto(null);
    setResult(null);
    setView('form');
  };

  const startOver = () => {
    setPhoto(null);
    setResult(null);
    setError(null);
    setView('form');
  };

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex h-14 max-w-md items-center gap-2 px-4">
          <img src="/favicon.svg" alt="" className="size-6" />
          <span className="text-lg font-bold tracking-tight text-gray-900">RxRoute</span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-md flex-1 px-4 py-6">
        {view === 'form' && (
          <>
            <h1 className="text-2xl font-bold tracking-tight text-gray-900">
              Find the nearest pharmacy with your medication in stock.
            </h1>
            <p className="mt-2 text-gray-500">
              Send a photo of your prescription. We'll ask the closest pharmacies at once and show you the first one
              that has it.
            </p>

            {error && (
              <div role="alert" className="mt-5 flex gap-3 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
                <AlertIcon className="size-5 shrink-0" />
                <p>{error}</p>
              </div>
            )}

            <form onSubmit={handleSubmit} className="mt-6 space-y-6 rounded-md border border-gray-200 bg-white p-5 shadow-sm">
              <Step number="1" title="Prescription">
                <PhotoPicker previewUrl={previewUrl} onSelect={setPhoto} onClear={() => setPhoto(null)} />
              </Step>

              <Step number="2" title="Your location">
                <LocationField location={location} onChange={setLocation} />
              </Step>

              <Step number="3" title="Contact">
                <PhoneField value={phone} onChange={setPhone} />
              </Step>

              <div className="border-t border-gray-200 pt-5">
                <button
                  type="submit"
                  disabled={!ready}
                  className="w-full rounded-md bg-emerald-600 px-4 py-3 font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-gray-500"
                >
                  Find pharmacies
                </button>
                {!ready && <p className="mt-2 text-center text-sm text-gray-500">Add {joinList(missing)} to continue.</p>}
              </div>
            </form>

            <p className="mt-4 text-center text-xs text-gray-500">
              RxRoute doesn't keep a copy of your photo. Only the medication names, your location and your phone number
              are saved with your request.
            </p>
          </>
        )}

        {view === 'processing' && <ProcessingView stage={stage} />}

        {view === 'result' && result && (
          <ResultView result={result} onRetakePhoto={retakePhoto} onStartOver={startOver} />
        )}
      </main>
    </div>
  );
}

function joinList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}
