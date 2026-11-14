import React, { forwardRef } from 'react';

interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  label?: string;
  error?: string;
  helperText?: string;
  fullWidth?: boolean;
  options: SelectOption[];
  placeholder?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, error, helperText, fullWidth, options, placeholder, className, ...props }, ref) => {
    return (
      <div className={`${fullWidth ? 'w-full' : ''} ${className || ''}`}>
        {label && (
          <label className="dashboard-eyebrow mb-2 block">
            {label}
            {props.required && <span className="ml-1 text-status-danger">*</span>}
          </label>
        )}

        <div className="relative">
          <select
            ref={ref}
            aria-invalid={error ? true : undefined}
            className="dashboard-select cursor-pointer appearance-none pr-10"
            {...props}
          >
            {placeholder && (
              <option value="" disabled>
                {placeholder}
              </option>
            )}
            {options.map((option) => (
              <option key={option.value} value={option.value} disabled={option.disabled}>
                {option.label}
              </option>
            ))}
          </select>

          {/* Custom dropdown arrow */}
          <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-text-muted">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M2 4L6 8L10 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        </div>

        {(error || helperText) && (
          <p className={`mt-1.5 text-xs ${error ? 'text-status-danger' : 'text-text-muted'}`}>
            {error || helperText}
          </p>
        )}
      </div>
    );
  }
);

Select.displayName = 'Select';
