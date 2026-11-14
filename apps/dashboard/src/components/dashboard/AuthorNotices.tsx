import { useCallback, useEffect, useState } from 'react';
import { api, type AuthorNotice } from '@/lib/api';
import { Button } from '@/components/ui/Button';

/**
 * What an owner's assignment told this person (journey r7): they were made the
 * author of a project that had no identifiable author, or (for an owner) another
 * owner took one over. Shown once, until dismissed. Nothing renders when there is
 * nothing to say, and a failed read says nothing rather than something false.
 */
export function AuthorNotices() {
  const [notices, setNotices] = useState<AuthorNotice[]>([]);

  useEffect(() => {
    let cancelled = false;
    api
      .getAuthorNotices()
      .then((res) => { if (!cancelled) setNotices(res.notices || []); })
      .catch(() => { /* no notice is better than a wrong one */ });
    return () => { cancelled = true; };
  }, []);

  const dismiss = useCallback(() => {
    const ids = notices.map((notice) => notice.notice_id);
    setNotices([]);
    api.markAuthorNoticesSeen(ids).catch(() => { /* shown again next time */ });
  }, [notices]);

  if (notices.length === 0) return null;
  return (
    <div role="status" className="mb-4 rounded-xl border border-primary/20 bg-primary/[0.04] p-4">
      <ul className="m-0 list-none space-y-1 p-0 text-sm leading-6 text-text-primary">
        {notices.map((notice) => <li key={notice.notice_id}>{notice.message}</li>)}
      </ul>
      <div className="mt-3">
        <Button size="sm" variant="secondary" onClick={dismiss}>Dismiss</Button>
      </div>
    </div>
  );
}
