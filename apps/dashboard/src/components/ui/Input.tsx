import React, { forwardRef } from 'react';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  helperText?: string;
  fullWidth?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, helperText, fullWidth, className, ...props }, ref) => {
    return (
      <div className={`${fullWidth ? 'w-full' : ''} ${className || ''}`}>
        {label && (
          <label className="dashboard-eyebrow mb-2 block">
            {label}
            {props.required && <span className="ml-1 text-status-danger">*</span>}
          </label>
        )}

        <input
          ref={ref}
          aria-invalid={error ? true : undefined}
          className={`dashboard-input ${error ? 'animate-[shake_0.3s_ease-in-out]' : ''}`}
          {...props}
        />

        {(error || helperText) && (
          <p className={`mt-1.5 text-xs ${error ? 'text-status-danger' : 'text-text-muted'}`}>
            {error || helperText}
          </p>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';

// Textarea variant
interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  helperText?: string;
  fullWidth?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ label, error, helperText, fullWidth, className, ...props }, ref) => {
    return (
      <div className={`${fullWidth ? 'w-full' : ''} ${className || ''}`}>
        {label && (
          <label className="dashboard-eyebrow mb-2 block">
            {label}
            {props.required && <span className="ml-1 text-status-danger">*</span>}
          </label>
        )}

        <textarea
          ref={ref}
          aria-invalid={error ? true : undefined}
          className={`dashboard-textarea resize-y ${error ? 'animate-[shake_0.3s_ease-in-out]' : ''}`}
          {...props}
        />

        {(error || helperText) && (
          <p className={`mt-1.5 text-xs ${error ? 'text-status-danger' : 'text-text-muted'}`}>
            {error || helperText}
          </p>
        )}
      </div>
    );
  }
);

Textarea.displayName = 'Textarea';
