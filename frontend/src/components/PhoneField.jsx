import { useId, useState } from 'react';
import { isValidNigerianPhone } from '../lib/format.js';

export default function PhoneField({ value, onChange }) {
  const id = useId();
  const hintId = useId();
  const [touched, setTouched] = useState(false);
  const showError = touched && value.trim() !== '' && !isValidNigerianPhone(value);

  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-gray-900">
        Phone number
      </label>
      <div
        className={`mt-2 flex rounded-md border bg-white focus-within:ring-2 focus-within:ring-emerald-600/20 ${
          showError ? 'border-red-600' : 'border-gray-300 focus-within:border-emerald-600'
        }`}
      >
        <span className="flex items-center rounded-l-md border-r border-gray-300 bg-gray-50 px-3 text-gray-500">+234</span>
        <input
          id={id}
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          placeholder="803 123 4567"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={() => setTouched(true)}
          aria-invalid={showError}
          aria-describedby={hintId}
          className="w-full min-w-0 rounded-r-md bg-transparent px-3 py-3 text-gray-900 placeholder:text-gray-400 focus:outline-none"
        />
      </div>
      <p id={hintId} className={`mt-2 text-sm ${showError ? 'text-red-700' : 'text-gray-500'}`}>
        {showError
          ? 'Enter a valid Nigerian number, e.g. 0803 123 4567.'
          : 'The pharmacy that accepts your request will call you on this number.'}
      </p>
    </div>
  );
}
