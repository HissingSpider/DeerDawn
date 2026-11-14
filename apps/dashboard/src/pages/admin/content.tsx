import Head from 'next/head';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { DashboardStatusPill, DashboardTableWrap, PageScaffold, PanelHeader, SurfacePanel } from '@/components/dashboard/PageScaffold';
import { Button } from '@/components/ui/Button';
import { showToast } from '@/components/ui/Toast';
import { api, ContentPage } from '@/lib/api';
import { logger } from '@/lib/logger';

const CONTENT_TYPES: Array<{ value: ContentPage['content_type']; label: string }> = [
  { value: 'use_case', label: 'Use case' },
  { value: 'comparison', label: 'Comparison' },
  { value: 'blog_post', label: 'Blog post' },
  { value: 'doc', label: 'Documentation' },
  { value: 'faq', label: 'FAQ' },
  { value: 'example', label: 'Example' },
  { value: 'resource', label: 'Resource' },
];

const emptyPage = (): ContentPage => ({
  content_type: 'use_case',
  slug: '',
  title: '',
  description: '',
  body_markdown: '',
  seo_title: '',
  seo_description: '',
  canonical_path: '',
  og_image: '',
  tags: [],
  category: '',
  status: 'draft',
  cta_label: 'Book a demo',
  cta_href: '/contact',
  specialized: {},
  published_at: null,
  scheduled_at: null,
});

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function statusTone(status: ContentPage['status']) {
  if (status === 'published') return 'success';
  if (status === 'scheduled') return 'info';
  if (status === 'archived') return 'danger';
  return 'neutral';
}

export default function ContentAdmin() {
  const [pages, setPages] = useState<ContentPage[]>([]);
  const [selected, setSelected] = useState<ContentPage>(emptyPage());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [specializedText, setSpecializedText] = useState('{\n  "pain": "",\n  "problem": "",\n  "solution": ""\n}');

  const loadPages = useCallback(async () => {
    setLoading(true);
    try {
      setPages(await api.listContentPages());
    } catch (error) {
      logger.error('content_pages_load_failed', error);
      showToast('Failed to load content pages', 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPages();
  }, [loadPages]);

  const preview = useMemo(() => {
    const paragraphs = selected.body_markdown.split(/\n{2,}/).filter(Boolean).slice(0, 4);
    return paragraphs.length > 0 ? paragraphs : ['Markdown preview appears here as you write.'];
  }, [selected.body_markdown]);

  const selectPage = (page: ContentPage) => {
    setSelected(page);
    setSpecializedText(JSON.stringify(page.specialized || {}, null, 2));
  };

  const update = <K extends keyof ContentPage>(key: K, value: ContentPage[K]) => {
    setSelected((current) => ({ ...current, [key]: value }));
  };

  const handleSave = async (publish = false) => {
    setSaving(true);
    try {
      const specialized = JSON.parse(specializedText || '{}');
      const payload = {
        ...selected,
        slug: selected.slug || slugify(selected.title),
        tags: selected.tags || [],
        specialized,
        status: publish ? 'published' as const : selected.status,
        published_at: publish ? new Date().toISOString() : selected.published_at,
      };
      const result = await api.saveContentPage(payload);
      setSelected(result.page);
      setSpecializedText(JSON.stringify(result.page.specialized || {}, null, 2));
      showToast(publish ? 'Content published' : 'Content saved', 'success');
      await loadPages();
    } catch (error: unknown) {
      logger.error('content_page_save_failed', error);
      showToast(error instanceof Error ? error.message : 'Failed to save content', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleArchive = async () => {
    if (!selected.content_id) return;
    setSaving(true);
    try {
      const result = await api.archiveContentPage(selected.content_id);
      setSelected(result.page);
      showToast('Content archived', 'success');
      await loadPages();
    } catch (error) {
      logger.error('content_page_archive_failed', error);
      showToast('Failed to archive content', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Head>
        <title>Content CMS | DeerDawn</title>
      </Head>

      <PageScaffold
        title="Content CMS"
        description="Create SEO landing pages, comparison pages, blog posts, docs, examples, FAQs, and gated resources for the public growth engine."
        action={<Button onClick={() => { setSelected(emptyPage()); setSpecializedText('{\n  "pain": "",\n  "problem": "",\n  "solution": ""\n}'); }}>New page</Button>}
      >
        <div className="grid gap-6 xl:grid-cols-[0.9fr_1.3fr]">
          <SurfacePanel>
            <PanelHeader title="Content inventory" description="Drafts, scheduled pages, and published growth assets." />
            {loading ? (
              <div className="p-6 text-sm text-text-secondary">Loading content…</div>
            ) : (
              <DashboardTableWrap>
                <table className="dashboard-table">
                  <thead>
                    <tr>
                      <th>Title</th>
                      <th>Type</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pages.map((page) => (
                      <tr key={page.content_id || page.slug} className="cursor-pointer" onClick={() => selectPage(page)}>
                        <td>
                          <div className="font-medium text-text-primary">{page.title}</div>
                          <div className="text-xs text-text-muted">/{page.slug}</div>
                        </td>
                        <td>{CONTENT_TYPES.find((type) => type.value === page.content_type)?.label}</td>
                        <td><DashboardStatusPill tone={statusTone(page.status)}>{page.status}</DashboardStatusPill></td>
                      </tr>
                    ))}
                    {pages.length === 0 ? (
                      <tr>
                        <td colSpan={3} className="text-text-secondary">No content pages yet.</td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </DashboardTableWrap>
            )}
          </SurfacePanel>

          <SurfacePanel>
            <PanelHeader
              title={selected.content_id ? 'Edit content' : 'Create content'}
              description="Markdown body plus typed SEO, CTA, and structured JSON fields."
              action={(
                <div className="flex gap-2">
                  {selected.content_id ? <Button variant="secondary" onClick={handleArchive} disabled={saving}>Archive</Button> : null}
                  <Button variant="secondary" onClick={() => handleSave(false)} disabled={saving}>Save draft</Button>
                  <Button onClick={() => handleSave(true)} disabled={saving}>Publish</Button>
                </div>
              )}
            />

            <div className="grid gap-5 p-6">
              <div className="grid gap-4 md:grid-cols-3">
                <label className="grid gap-2">
                  <span className="dashboard-eyebrow">Type</span>
                  <select name="content_type" value={selected.content_type} onChange={(event) => update('content_type', event.target.value as ContentPage['content_type'])} className="dashboard-input">
                    {CONTENT_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
                  </select>
                </label>
                <label className="grid gap-2 md:col-span-2">
                  <span className="dashboard-eyebrow">Slug</span>
                  <input name="slug" value={selected.slug} onChange={(event) => update('slug', slugify(event.target.value))} placeholder="ai-refund-approval" className="dashboard-input" />
                </label>
              </div>

              <label className="grid gap-2">
                <span className="dashboard-eyebrow">Title</span>
                <input name="title" value={selected.title} onChange={(event) => update('title', event.target.value)} placeholder="Stop AI refund approvals from becoming losses" className="dashboard-input" />
              </label>

              <label className="grid gap-2">
                <span className="dashboard-eyebrow">Description</span>
                <textarea name="description" value={selected.description} onChange={(event) => update('description', event.target.value)} rows={3} className="dashboard-textarea" />
              </label>

              <div className="grid gap-4 md:grid-cols-2">
                <label className="grid gap-2">
                  <span className="dashboard-eyebrow">SEO title</span>
                  <input name="seo_title" value={selected.seo_title || ''} onChange={(event) => update('seo_title', event.target.value)} className="dashboard-input" />
                </label>
                <label className="grid gap-2">
                  <span className="dashboard-eyebrow">SEO description</span>
                  <input name="seo_description" value={selected.seo_description || ''} onChange={(event) => update('seo_description', event.target.value)} className="dashboard-input" />
                </label>
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                <label className="grid gap-2">
                  <span className="dashboard-eyebrow">Category</span>
                  <input name="category" value={selected.category || ''} onChange={(event) => update('category', event.target.value)} className="dashboard-input" />
                </label>
                <label className="grid gap-2">
                  <span className="dashboard-eyebrow">CTA label</span>
                  <input name="cta_label" value={selected.cta_label || ''} onChange={(event) => update('cta_label', event.target.value)} className="dashboard-input" />
                </label>
                <label className="grid gap-2">
                  <span className="dashboard-eyebrow">CTA href</span>
                  <input name="cta_href" value={selected.cta_href || ''} onChange={(event) => update('cta_href', event.target.value)} className="dashboard-input" />
                </label>
              </div>

              <label className="grid gap-2">
                <span className="dashboard-eyebrow">Tags, comma separated</span>
                <input name="tags" value={(selected.tags || []).join(', ')} onChange={(event) => update('tags', event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean))} className="dashboard-input" />
              </label>

              <div className="grid gap-4 lg:grid-cols-2">
                <label className="grid gap-2">
                  <span className="dashboard-eyebrow">Markdown body</span>
                  <textarea name="body_markdown" value={selected.body_markdown} onChange={(event) => update('body_markdown', event.target.value)} rows={14} className="rounded-2xl border border-border-subtle bg-[var(--code-bg)] px-4 py-3 font-mono text-sm leading-6 text-text-primary outline-none" />
                </label>
                <div className="grid gap-2">
                  <span className="dashboard-eyebrow">Preview</span>
                  <div className="min-h-[360px] rounded-2xl border border-border-subtle bg-overlay-subtle p-5 text-sm leading-7 text-text-secondary">
                    <h3 className="text-xl font-semibold text-text-primary">{selected.title || 'Untitled content'}</h3>
                    <p className="mt-2">{selected.description || 'Description preview appears here.'}</p>
                    <div className="mt-5 space-y-3">
                      {preview.map((paragraph) => <p key={paragraph}>{paragraph.replace(/^#+\s*/, '')}</p>)}
                    </div>
                  </div>
                </div>
              </div>

              <label className="grid gap-2">
                <span className="dashboard-eyebrow">Specialized JSON</span>
                <textarea name="specialized" value={specializedText} onChange={(event) => setSpecializedText(event.target.value)} rows={8} className="rounded-2xl border border-border-subtle bg-[var(--code-bg)] px-4 py-3 font-mono text-sm leading-6 text-text-primary outline-none" />
              </label>
            </div>
          </SurfacePanel>
        </div>
      </PageScaffold>
    </>
  );
}
