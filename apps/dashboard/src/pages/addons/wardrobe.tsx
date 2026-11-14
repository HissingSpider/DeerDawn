import Head from 'next/head';
import { useRouter } from 'next/router';
import { PageScaffold } from '@/components/dashboard/PageScaffold';
import { ClosetTab } from '@/components/addons/wardrobe/ClosetTab';
import { OutfitsTab } from '@/components/addons/wardrobe/OutfitsTab';
import { StylesTab } from '@/components/addons/wardrobe/StylesTab';
import { EnableGate } from '@/components/addons/wardrobe/EnableGate';

const TABS = [
  { id: 'closet', label: 'Closet' },
  { id: 'outfits', label: 'Outfits' },
  { id: 'styles', label: 'Styles' },
] as const;
type TabId = (typeof TABS)[number]['id'];

// The Wardrobe add-on's own page. The tab lives in the query string so a
// reload, a shared link or the browser's back button lands on the same tab.
export default function WardrobePage() {
  const router = useRouter();
  const requested = typeof router.query.tab === 'string' ? router.query.tab : '';
  const tab: TabId = TABS.some((t) => t.id === requested) ? (requested as TabId) : 'closet';

  const choose = (id: TabId) => {
    void router.replace({ pathname: router.pathname, query: id === 'closet' ? {} : { tab: id } }, undefined, { shallow: true });
  };

  return (
    <>
      <Head><title>Wardrobe | DeerDawn</title></Head>
      <PageScaffold
        title="Wardrobe"
        description="Your clothes, the outfits your AI puts together from them, and the styles you like. Private to you."
      >
        <EnableGate>
          <div
            role="tablist"
            aria-label="Wardrobe sections"
            className="inline-flex w-fit gap-1 rounded-lg border border-border-subtle bg-overlay-subtle p-1"
          >
            {TABS.map((t) => {
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  id={`wardrobe-tab-${t.id}`}
                  aria-selected={active}
                  aria-controls={`wardrobe-panel-${t.id}`}
                  onClick={() => choose(t.id)}
                  className={`rounded-md px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                    active ? 'bg-primary text-on-primary' : 'text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
          <div role="tabpanel" id={`wardrobe-panel-${tab}`} aria-labelledby={`wardrobe-tab-${tab}`}>
            {tab === 'closet' ? <ClosetTab /> : tab === 'outfits' ? <OutfitsTab /> : <StylesTab />}
          </div>
        </EnableGate>
      </PageScaffold>
    </>
  );
}
