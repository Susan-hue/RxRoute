import { CheckIcon } from './icons.jsx';

const STEPS = [
  { id: 'uploading', label: 'Uploading photo' },
  { id: 'analyzing', label: 'Analyzing prescription' },
  { id: 'locating', label: 'Locating pharmacies' },
  { id: 'broadcasting', label: 'Broadcasting request' },
];

/** Each step reflects a real stage reported by the backend, not a timer. */
export default function ProcessingView({ stage }) {
  const current = STEPS.findIndex((step) => step.id === stage);

  return (
    <section className="rounded-md border border-gray-200 bg-white p-5 shadow-sm" aria-live="polite">
      <h2 className="text-lg font-bold text-gray-900">Working on your request</h2>
      <p className="mt-1 text-sm text-gray-500">This can take up to a minute. Please keep this page open.</p>

      <ol className="mt-5 space-y-3">
        {STEPS.map((step, index) => {
          const done = index < current;
          const active = index === current;

          return (
            <li key={step.id} className="flex items-center gap-3">
              <span
                className={`flex size-6 shrink-0 items-center justify-center rounded-full border ${
                  done
                    ? 'border-emerald-600 bg-emerald-600 text-white'
                    : active
                      ? 'border-emerald-600 bg-white'
                      : 'border-gray-300 bg-white'
                }`}
              >
                {done && <CheckIcon className="size-4" />}
                {active && <span className="size-2 animate-pulse rounded-full bg-emerald-600" />}
              </span>
              <span className={done || active ? 'text-gray-900' : 'text-gray-400'}>
                {step.label}
                {active && '...'}
              </span>
            </li>
          );
        })}
      </ol>

      <div className="mt-6 space-y-3 border-t border-gray-200 pt-5" aria-hidden="true">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex animate-pulse items-center justify-between gap-4">
            <div className="flex-1 space-y-2">
              <div className="h-3.5 w-2/3 rounded bg-gray-200" />
              <div className="h-3 w-1/2 rounded bg-gray-100" />
            </div>
            <div className="h-3.5 w-12 rounded bg-gray-200" />
          </div>
        ))}
      </div>
    </section>
  );
}
