import React from 'react';

interface ProgressBarProps {
  value: number;
  max?: number;
  variant?: 'primary' | 'success' | 'warning' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  showLabel?: boolean;
  animated?: boolean;
  className?: string;
}

export const ProgressBar: React.FC<ProgressBarProps> = ({
  value,
  max = 100,
  variant = 'primary',
  size = 'md',
  showLabel = false,
  animated = false,
  className
}) => {
  const percentage = Math.min(Math.max((value / max) * 100, 0), 100);

  const variantClasses = {
    primary: 'bg-primary shadow-[0_0_8px_rgba(16,185,129,0.3)]',
    success: 'bg-primary shadow-[0_0_8px_rgba(16,185,129,0.3)]',
    warning: 'bg-accent shadow-[0_0_8px_rgba(251,191,36,0.3)]',
    danger: 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.3)]'
  };

  const sizeClasses = {
    sm: 'h-1.5',
    md: 'h-2.5',
    lg: 'h-3'
  };

  return (
    <div className={`w-full ${className || ''}`}>
      <div
        className={`w-full bg-surface border border-border rounded-full overflow-hidden ${sizeClasses[size]}`}
        role="progressbar"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
      >
        <div
          className={`h-full rounded-full transition-all duration-500 ease-out ${variantClasses[variant]} ${animated ? 'animate-pulse' : ''}`}
          style={{ width: `${percentage}%` }}
        />
      </div>
      {showLabel && (
        <div className="mt-1.5 flex justify-between items-center text-xs text-text-muted">
          <span>{value.toLocaleString()} / {max.toLocaleString()}</span>
          <span className="font-medium">{percentage.toFixed(0)}%</span>
        </div>
      )}
    </div>
  );
};
