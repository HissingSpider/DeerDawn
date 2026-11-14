import React, { useId, useState } from 'react';

interface Tab {
  id: string;
  label: string;
  icon?: React.ReactNode;
  content: React.ReactNode;
  disabled?: boolean;
}

interface TabsProps {
  tabs: Tab[];
  defaultTab?: string;
  variant?: 'default' | 'pills';
  onChange?: (tabId: string) => void;
  className?: string;
}

export const Tabs: React.FC<TabsProps> = ({
  tabs,
  defaultTab,
  variant = 'default',
  onChange,
  className
}) => {
  const [activeTab, setActiveTab] = useState(defaultTab || tabs[0]?.id);
  const tabListId = useId();

  const handleTabChange = (tabId: string) => {
    const tab = tabs.find(t => t.id === tabId);
    if (tab && !tab.disabled) {
      setActiveTab(tabId);
      onChange?.(tabId);
    }
  };

  const activeTabContent = tabs.find(t => t.id === activeTab)?.content;

  return (
    <div className={`w-full ${className || ''}`}>
      {/* Tab List */}
      <div
        className={`
        ${variant === 'pills'
          ? 'flex gap-2 p-1 bg-surface/50 rounded-lg border border-border w-fit'
          : 'border-b border-border'
        }
      `}
        role="tablist"
        aria-orientation="horizontal"
        id={tabListId}
      >
        <div className="flex gap-1">
          {tabs.map((tab) => {
            const isActive = activeTab === tab.id;
            const tabButtonId = `${tabListId}-${tab.id}`;
            const panelId = `${tabButtonId}-panel`;

            return (
              <button
                key={tab.id}
                onClick={() => handleTabChange(tab.id)}
                disabled={tab.disabled}
                className={`
                  relative px-4 py-2.5 text-sm font-medium
                  transition-all duration-200
                  ${variant === 'pills' ? 'rounded-md' : ''}
                  ${isActive
                    ? variant === 'pills'
                      ? 'bg-primary text-on-primary shadow-sm'
                      : 'text-primary border-b-2 border-primary'
                    : tab.disabled
                      ? 'text-text-muted cursor-not-allowed opacity-50'
                      : 'text-text-secondary hover:text-text-primary hover:bg-overlay-hover'
                  }
                  ${tab.disabled ? '' : 'cursor-pointer'}
                  flex items-center gap-2
                `}
                role="tab"
                id={tabButtonId}
                aria-selected={isActive}
                aria-disabled={tab.disabled}
                aria-controls={panelId}
                tabIndex={isActive ? 0 : -1}
              >
                {tab.icon && <span className="flex-shrink-0">{tab.icon}</span>}
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Tab Content */}
      <div
        className="mt-6"
        role="tabpanel"
        id={`${tabListId}-${activeTab}-panel`}
        aria-labelledby={`${tabListId}-${activeTab}`}
      >
        {activeTabContent}
      </div>
    </div>
  );
};
