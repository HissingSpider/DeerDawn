import React from 'react';

interface CardProps {
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
  title?: string;
  action?: React.ReactNode;
  footer?: React.ReactNode;
  isLoading?: boolean;
  hover?: boolean;
}

export const Card: React.FC<CardProps> = ({
  children,
  className,
  contentClassName,
  title,
  action,
  footer,
  isLoading,
  hover = false
}) => {
  return (
    <div
      className={`
        border border-border-subtle bg-surface rounded-lg overflow-hidden shadow-[0_16px_44px_rgba(0,0,0,0.24)]
        ${hover ? 'hover:border-border transition-colors' : ''}
        ${className || ''}
      `}
    >
      {(title || action) && (
        <div className="px-6 py-4 border-b border-border-subtle flex justify-between items-center">
          {title && <h3 className="text-[11px] font-semibold text-text-muted uppercase tracking-wider">{title}</h3>}
          {action && <div>{action}</div>}
        </div>
      )}
      <div className={`p-6 ${contentClassName || ''}`}>
        {isLoading ? (
          <div className="flex justify-center py-8">
            <svg className="animate-spin h-6 w-6 text-primary" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
          </div>
        ) : children}
      </div>
      {footer && (
        <div className="px-6 py-4 border-t border-border-subtle bg-surface/80">
          {footer}
        </div>
      )}
    </div>
  );
};
