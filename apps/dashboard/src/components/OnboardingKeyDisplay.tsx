import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { logger } from '@/lib/logger';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EyeIcon, EyeOffIcon } from '@/components/icons';
import { siteConfig } from '@/lib/siteConfig';

export const OnboardingKeyDisplay: React.FC = () => {
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Check if already dismissed in this session
    if (sessionStorage.getItem('onboarding_key_dismissed')) {
      return;
    }

    // Fetch onboarding key
    api.getOnboardingKey()
      .then((response) => {
        if (response.key) {
          setApiKey(response.key);
        }
      })
      .catch((err) => {
        logger.error('onboarding_key_fetch_failed', err);
      });
  }, []);

  const handleCopy = () => {
    if (apiKey) {
      navigator.clipboard.writeText(apiKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleDismiss = () => {
    setDismissed(true);
    sessionStorage.setItem('onboarding_key_dismissed', 'true');
  };

  // Don't render if no key or dismissed
  if (!apiKey || dismissed) {
    return null;
  }

  // Masked by default — the live secret only renders when the user reveals it.
  const maskedKey = `${apiKey.slice(0, 10)}${'•'.repeat(22)}`;

  return (
    <Card className="bg-primary/[0.06] border-primary/30">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="text-lg font-medium text-primary mb-2">
            Your API Key is Ready
          </h3>
          <p className="text-sm text-text-secondary">
            We've automatically created a sandbox API key for you. Copy it now - you won't see it again.
          </p>
        </div>
        <button
          onClick={handleDismiss}
          className="text-text-muted hover:text-text-primary transition-colors"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>

      <div className="bg-background border border-border rounded p-4 mb-4 font-mono text-sm">
        <div className="flex items-center justify-between gap-3">
          <code className="text-primary break-all">{revealed ? apiKey : maskedKey}</code>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setRevealed((v) => !v)}
              aria-label={revealed ? 'Hide API key' : 'Show API key'}
              className="text-text-muted hover:text-text-primary transition-colors"
            >
              {revealed ? <EyeOffIcon /> : <EyeIcon />}
            </button>
            <Button size="sm" onClick={handleCopy}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
      </div>

      <div className="text-sm text-text-secondary space-y-2">
        <p className="font-medium text-text-primary">Next steps:</p>
        <ul className="list-disc list-inside space-y-1 ml-2">
          <li>Install the SDK: <code className="text-primary">npm install deerdawn</code></li>
          <li>Use this key in your code: <code className="text-primary">apiKey: '{apiKey.slice(0, 15)}...'</code></li>
          <li>Check out the <a href={`${siteConfig.PRIMARY_SITE_URL}/docs`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">documentation</a> for examples</li>
        </ul>
      </div>
    </Card>
  );
};
