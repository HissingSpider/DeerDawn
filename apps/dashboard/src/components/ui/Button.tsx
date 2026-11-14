import React from 'react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  isLoading?: boolean;
}

export const Button: React.FC<ButtonProps> = ({
  variant = 'primary',
  size = 'md',
  isLoading,
  className,
  children,
  ...props
}) => {
  const baseClasses = 'ui-press inline-flex items-center justify-center rounded-lg font-medium transition-all duration-200 cursor-pointer border focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-background disabled:cursor-not-allowed disabled:active:scale-100';

  const variantClasses = {
    primary: 'bg-primary text-on-primary border-primary/40 hover:bg-primary-hover hover:border-primary-hover focus:ring-primary shadow-[0_14px_30px_-18px_rgba(16,185,129,0.75)] disabled:bg-surface-hover disabled:text-text-secondary disabled:border-border disabled:shadow-none',
    secondary: 'bg-overlay-subtle border-border-subtle text-text-primary hover:bg-overlay-strong hover:border-border-strong focus:ring-border disabled:bg-overlay-subtle disabled:text-text-muted disabled:border-border-subtle',
    ghost: 'bg-transparent text-text-primary border-transparent hover:text-text-primary hover:bg-overlay-hover focus:ring-border disabled:text-text-muted disabled:bg-transparent',
    // Quiet destructive: token-driven text on a hairline border, so it stays
    // legible in BOTH themes (4.9:1 light / 6.4:1 dark). The previous
    // `text-red-200` was a dark-first shade that fell to ~1.4:1 on the light
    // surface — the reason Revoke was unreadable.
    danger: 'bg-transparent text-status-danger border-border-subtle hover:bg-[var(--status-deny-bg)] hover:border-status-danger focus:ring-status-danger disabled:opacity-50'
  };

  const sizeClasses = {
    sm: 'px-3 h-9 text-xs gap-1.5',
    md: 'px-[18px] h-11 text-sm gap-2',
    lg: 'px-6 py-3.5 text-base gap-2'
  };

  return (
    <button
      className={`${baseClasses} ${variantClasses[variant]} ${sizeClasses[size]} ${className || ''}`}
      disabled={isLoading || props.disabled}
      {...props}
    >
      {isLoading ? (
        <svg className="animate-spin h-4 w-4 opacity-0 animate-[spin_1s_linear_infinite,fadeIn_0.3s_ease-in]" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
      ) : children}
    </button>
  );
};
