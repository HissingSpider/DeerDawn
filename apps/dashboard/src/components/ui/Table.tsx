import React from 'react';

interface TableProps {
  headers: string[];
  children: React.ReactNode;
  isLoading?: boolean;
  emptyState?: React.ReactNode;
  className?: string;
}

export const Table: React.FC<TableProps> = ({
  headers,
  children,
  isLoading,
  emptyState,
  className
}) => {
  const hasData = React.Children.count(children) > 0;

  return (
    <div className={`w-full overflow-x-auto border border-border rounded-lg bg-surface/30 shadow-sm ${className || ''}`}>
      <table className="w-full border-collapse text-sm text-left">
        <thead className="sticky top-0 z-10 backdrop-blur-sm bg-surface/95">
          <tr>
            {headers.map((h, i) => (
              <th
                key={i}
                className="bg-surface px-4 py-3.5 font-semibold text-[11px] uppercase tracking-wider text-text-muted border-b border-border"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {isLoading ? (
            // Loading skeleton rows
            Array.from({ length: 3 }).map((_, i) => (
              <tr key={i}>
                {headers.map((_, j) => (
                  <td key={j} className="px-4 py-4 border-b border-border">
                    <div className="h-4 bg-surface rounded-sm animate-pulse" />
                  </td>
                ))}
              </tr>
            ))
          ) : !hasData && emptyState ? (
            <tr>
              <td colSpan={headers.length} className="px-4 py-12 text-center text-text-muted font-medium">
                {emptyState}
              </td>
            </tr>
          ) : (
            children
          )}
        </tbody>
      </table>
    </div>
  );
};

// Table row component for consistent styling
export const TableRow: React.FC<{
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
  style?: React.CSSProperties;
}> = ({
  children,
  className,
  onClick,
  style
}) => (
  <tr
    className={`
      relative group
      hover:bg-overlay-strong transition-all duration-200
      before:absolute before:left-0 before:top-0 before:bottom-0 before:w-0
      before:bg-primary before:transition-all before:duration-200
      hover:before:w-1
      ${onClick ? 'cursor-pointer' : ''}
      ${className || ''}
    `}
    onClick={onClick}
    style={style}
  >
    {children}
  </tr>
);

// Table cell component for consistent styling
export const TableCell: React.FC<{ children: React.ReactNode; className?: string }> = ({
  children,
  className
}) => (
  <td className={`px-4 py-4 text-text-primary border-b border-border last:border-b-0 ${className || ''}`}>
    {children}
  </td>
);
