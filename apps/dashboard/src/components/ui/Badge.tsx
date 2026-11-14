import React from 'react';

interface BadgeProps {
  variant?: 'success' | 'danger' | 'warning' | 'neutral';
  size?: 'sm' | 'md';
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

export const Badge: React.FC<BadgeProps> = ({
  variant = 'neutral',
  size = 'md',
  icon,
  children,
  className,
  style
}) => {
  const baseClasses = 'inline-flex items-center justify-center whitespace-nowrap rounded border font-semibold uppercase tracking-[0.06em]';

  const variantClasses = {
    success:   'bg-primary/10 text-primary border-primary/20',
    danger:    'bg-red-500/10 text-status-danger border-red-500/20',
    warning:'bg-amber-500/10 text-status-warning border-amber-500/20',
    neutral: 'bg-overlay-subtle text-text-muted border-border-subtle',
  };

  const sizeClasses = {
    sm: 'px-2 py-0.5 text-[10px] gap-1',
    md: 'px-2.5 py-1 text-xs gap-1.5'
  };

  return (
    <span className={`${baseClasses} ${variantClasses[variant]} ${sizeClasses[size]} ${className || ''}`} style={style}>
      {icon && <span className="flex-shrink-0">{icon}</span>}
      {children}
    </span>
  );
};