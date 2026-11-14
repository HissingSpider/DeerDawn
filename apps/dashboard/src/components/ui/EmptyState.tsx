import React from 'react';
import { Button } from '@/components/ui/Button';

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
  className?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  icon,
  title,
  description,
  action,
  className
}) => {
  return (
    <div
      className={`flex flex-col items-center justify-center py-12 px-4 text-center ${className || ''}`}
    >
      {icon && (
        <div className="w-12 h-12 rounded-full bg-surface/40 border border-border flex items-center justify-center mb-4 text-text-muted">
          {icon}
        </div>
      )}

      <h3 className="text-lg font-medium text-text-primary mb-2">
        {title}
      </h3>

      {description && (
        <p className="text-sm text-text-secondary max-w-md mb-6 leading-relaxed">
          {description}
        </p>
      )}

      {action && (
        <Button onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
};
