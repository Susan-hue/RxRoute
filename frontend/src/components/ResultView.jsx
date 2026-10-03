import { useEffect, useState } from 'react';
import { getPrescriptionStatus } from '../lib/api.js';
import { directionsUrl, formatDistance } from '../lib/format.js';
import { AlertIcon, CheckIcon, PhoneIcon } from './icons.jsx';

const POLL_INTERVAL_MS = 5000;

const card = 'rounded-md border border-gray-200 bg-white p-5 shadow-sm';
const primaryButton =
  'flex w-full items-center justify-center gap-2 rounded-md bg-emerald-600 px-4 py-3 font-medium text-white hover:bg-emerald-700';
const secondaryButton =
  'flex w-full items-center justify-center gap-2 rounded-md border border-gray-300 bg-white px-4 py-3 font-medium text-gray-900 hover:bg-gray-50';

/** Polls the request until a pharmacy accepts it or it expires. */
function useRequestStatus(id) {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    if (!id) return undefined;

    let cancelled = false;
    let timer;

    const poll = async () => {
      try {
        const next = await getPrescriptionStatus(id);
        if (cancelled) return;
        setStatus(next);
        if (next.status !== 'pending') return;
      } catch {
        // A dropped poll on a patchy connection is retried on the next tick.
      }
      if (!cancelled) timer = setTimeout(poll, POLL_INTERVAL_MS);
    };

    timer = setTimeout(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [id]);

  return status;
}

function ProblemCard({ title, children, action }) {
  return (
    <section className={card}>
      <div className="flex gap-3">
        <AlertIcon className="mt-0.5 size-5 shrink-0 text-amber-600" />
        <div>
          <h2 className="text-lg font-bold text-gray-900">{title}</h2>
          <div className="mt-1 text-gray-500">{children}</div>
        </div>
      </div>
      {action && <div className="mt-5">{action}</div>}
    </section>
  );
}

function StatusPanel({ result, status }) {
  const shortCode = result.request.short_code;
  const winner = status?.claimed_by;
  const total = result.pharmacies.length;

  if (result.delivered === 0) {
    return (
      <ProblemCard title="We couldn't reach the pharmacies">
        <p>
          We found {total} {total === 1 ? 'pharmacy' : 'pharmacies'} near you, but your request could not be delivered
          to any of them. Please try again in a few minutes.
        </p>
      </ProblemCard>
    );
  }

  if (status?.status === 'claimed' && winner) {
    return (
      <section className="rounded-md border border-emerald-600 bg-white p-5 shadow-sm" aria-live="polite">
        <div className="flex items-center gap-2 text-sm font-medium text-emerald-700">
          <CheckIcon className="size-4" />
          Confirmed
        </div>
        <h2 className="mt-2 text-lg font-bold text-gray-900">{winner.name} has your medication</h2>
        {winner.address && <p className="mt-1 text-gray-500">{winner.address}</p>}
        <p className="mt-1 text-sm text-gray-500">They have your phone number and may call to confirm. Your reference is {shortCode}.</p>

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {winner.latitude != null && winner.longitude != null && (
            <a href={directionsUrl(winner.latitude, winner.longitude)} target="_blank" rel="noreferrer" className={primaryButton}>
              Get directions
            </a>
          )}
          {winner.phone && (
            <a href={`tel:${winner.phone}`} className={secondaryButton}>
              <PhoneIcon className="size-4" />
              Call pharmacy
            </a>
          )}
        </div>
      </section>
    );
  }

  if (status && status.status !== 'pending') {
    return (
      <section className={card} aria-live="polite">
        <h2 className="text-lg font-bold text-gray-900">No pharmacy confirmed in time</h2>
        <p className="mt-1 text-gray-500">
          None of the pharmacies accepted request {shortCode}. You can start a new request to try again.
        </p>
      </section>
    );
  }

  return (
    <section className={card} aria-live="polite">
      <p className="text-sm text-gray-500">Reference {shortCode}</p>
      <h2 className="mt-1 text-lg font-bold text-gray-900">
        {result.delivered < total
          ? `Request sent to ${result.delivered} of ${total} pharmacies`
          : `Request sent to ${total} ${total === 1 ? 'pharmacy' : 'pharmacies'}`}
      </h2>
      <p className="mt-1 text-gray-500">
        The first pharmacy to confirm they have your medication will appear here. Keep this page open.
      </p>
      <div className="mt-4 flex items-center gap-2 text-sm text-gray-900">
        <span className="size-2 animate-pulse rounded-full bg-emerald-600" />
        Waiting for a pharmacy to confirm
      </div>
    </section>
  );
}

export default function ResultView({ result, onRetakePhoto, onStartOver }) {
  const reachedAny = result.outcome === 'broadcast' && result.delivered > 0;
  const status = useRequestStatus(reachedAny ? result.request?.id : null);

  if (result.outcome === 'invalid_prescription') {
    return (
      <ProblemCard
        title="We couldn't read this prescription"
        action={
          <button type="button" onClick={onRetakePhoto} className={primaryButton}>
            Try another photo
          </button>
        }
      >
        <p>{result.reason ?? 'The photo does not look like a prescription.'}</p>
        <p className="mt-2 text-sm">Lay the paper flat in good light and make sure the medication names are in focus.</p>
      </ProblemCard>
    );
  }

  if (result.outcome === 'no_pharmacies') {
    return (
      <ProblemCard
        title="No pharmacies found nearby"
        action={
          <button type="button" onClick={onStartOver} className={secondaryButton}>
            Start over
          </button>
        }
      >
        <p>
          We couldn't find a registered pharmacy within {formatDistance(result.radius_meters)} of your location. Your
          medication was read correctly, so you can show it to any pharmacy you visit.
        </p>
      </ProblemCard>
    );
  }

  return (
    <div className="space-y-4">
      <StatusPanel result={result} status={status} />

      {result.drugs.length > 0 && (
        <section className={card}>
          <h3 className="font-bold text-gray-900">Medication on your prescription</h3>
          <ul className="mt-3 divide-y divide-gray-200">
            {result.drugs.map((drug, index) => (
              <li key={`${drug.name}-${index}`} className="flex justify-between gap-4 py-2">
                <span className="text-gray-900">{drug.name}</span>
                {drug.dose && <span className="text-right text-gray-500">{drug.dose}</span>}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm text-gray-500">Read automatically from your photo. The pharmacist will confirm it.</p>
        </section>
      )}

      <section className={card}>
        <h3 className="font-bold text-gray-900">{reachedAny ? 'Pharmacies contacted' : 'Pharmacies near you'}</h3>
        {result.widened && (
          <p className="mt-1 text-sm text-gray-500">
            There were none close by, so we searched up to {formatDistance(result.radius_meters)} away.
          </p>
        )}
        <ul className="mt-3 divide-y divide-gray-200">
          {result.pharmacies.map((pharmacy) => (
            <li key={pharmacy.id} className="flex items-start justify-between gap-4 py-3">
              <div className="min-w-0">
                <p className="text-gray-900">{pharmacy.name}</p>
                {pharmacy.address && <p className="text-sm text-gray-500">{pharmacy.address}</p>}
              </div>
              <span className="shrink-0 text-sm text-gray-500 tabular-nums">{formatDistance(pharmacy.distance_meters)}</span>
            </li>
          ))}
        </ul>
      </section>

      <button type="button" onClick={onStartOver} className={secondaryButton}>
        Start a new request
      </button>
    </div>
  );
}
