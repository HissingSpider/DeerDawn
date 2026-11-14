const express = require('express');
const db = require('../config/db');
const { requireAuth, requirePlatformStaff } = require('../middleware/auth');
const { ContentPageUpsertSchema } = require('../schemas');

const router = express.Router();

// AUTHZ-002: the global CMS writes cross-tenant marketing content under the org-system
// context. It is platform-staff only — a tenant 'admin'/'owner' must NOT be able to reach it.
router.use(requireAuth, requirePlatformStaff);

const PUBLIC_COLUMNS = `
  content_id, content_type, slug, title, description, body_markdown, seo_title,
  seo_description, canonical_path, og_image, tags, category, status, cta_label,
  cta_href, specialized, published_at, scheduled_at, created_at, updated_at
`;

function normalizeStatus(input) {
    if (input.status === 'scheduled') return 'scheduled';
    if (input.status === 'published') return 'published';
    if (input.status === 'archived') return 'archived';
    return 'draft';
}

function resolvePublishedAt(input) {
    if (input.status !== 'published') return input.published_at || null;
    return input.published_at || new Date().toISOString();
}

async function writeVersion(contentId, actorId) {
    const page = await db.query(`SELECT ${PUBLIC_COLUMNS} FROM content_pages WHERE content_id = $1`, [contentId], 'org-system');
    if (page.rows.length === 0) return;

    const latest = await db.query(
        'SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version FROM content_versions WHERE content_id = $1',
        [contentId],
        'org-system'
    );

    await db.query(
        `INSERT INTO content_versions (version_id, content_id, version_number, snapshot, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [crypto.randomUUID(), contentId, latest.rows[0].next_version, page.rows[0], actorId],
        'org-system'
    );
}

router.get('/', async (req, res) => {
    const type = req.query.type;
    const params = [];
    let where = '';

    if (type) {
        params.push(type);
        where = 'WHERE content_type = $1';
    }

    const result = await db.query(
        `SELECT ${PUBLIC_COLUMNS} FROM content_pages ${where} ORDER BY updated_at DESC LIMIT 250`,
        params,
        'org-system'
    );

    res.json({ pages: result.rows });
});

router.get('/:contentId', async (req, res) => {
    const result = await db.query(
        `SELECT ${PUBLIC_COLUMNS} FROM content_pages WHERE content_id = $1`,
        [req.params.contentId],
        'org-system'
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    res.json({ page: result.rows[0] });
});

router.post('/', async (req, res) => {
    const parsed = ContentPageUpsertSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: 'invalid_payload', details: parsed.error.issues });
    }

    const input = parsed.data;
    const contentId = crypto.randomUUID();
    const status = normalizeStatus(input);

    try {
        const result = await db.query(
            `INSERT INTO content_pages (
              content_id, content_type, slug, title, description, body_markdown, seo_title,
              seo_description, canonical_path, og_image, tags, category, status, cta_label,
              cta_href, specialized, created_by, updated_by, published_at, scheduled_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $17, $18, $19)
            RETURNING ${PUBLIC_COLUMNS}`,
            [
                contentId,
                input.content_type,
                input.slug,
                input.title,
                input.description,
                input.body_markdown,
                input.seo_title,
                input.seo_description,
                input.canonical_path,
                input.og_image,
                input.tags,
                input.category,
                status,
                input.cta_label,
                input.cta_href,
                input.specialized,
                req.actor.id,
                resolvePublishedAt(input),
                input.scheduled_at || null,
            ],
            'org-system'
        );

        await writeVersion(contentId, req.actor.id);
        res.status(201).json({ page: result.rows[0] });
    } catch (error) {
        if (error.code === '23505') return res.status(409).json({ error: 'slug_conflict' });
        throw error;
    }
});

router.put('/:contentId', async (req, res) => {
    const parsed = ContentPageUpsertSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: 'invalid_payload', details: parsed.error.issues });
    }

    const input = parsed.data;
    const status = normalizeStatus(input);

    try {
        const result = await db.query(
            `UPDATE content_pages
             SET content_type = $2, slug = $3, title = $4, description = $5, body_markdown = $6,
                 seo_title = $7, seo_description = $8, canonical_path = $9, og_image = $10,
                 tags = $11, category = $12, status = $13, cta_label = $14, cta_href = $15,
                 specialized = $16, updated_by = $17, published_at = $18, scheduled_at = $19,
                 updated_at = NOW()
             WHERE content_id = $1
             RETURNING ${PUBLIC_COLUMNS}`,
            [
                req.params.contentId,
                input.content_type,
                input.slug,
                input.title,
                input.description,
                input.body_markdown,
                input.seo_title,
                input.seo_description,
                input.canonical_path,
                input.og_image,
                input.tags,
                input.category,
                status,
                input.cta_label,
                input.cta_href,
                input.specialized,
                req.actor.id,
                resolvePublishedAt(input),
                input.scheduled_at || null,
            ],
            'org-system'
        );

        if (result.rows.length === 0) return res.status(404).json({ error: 'not_found' });
        await writeVersion(req.params.contentId, req.actor.id);
        res.json({ page: result.rows[0] });
    } catch (error) {
        if (error.code === '23505') return res.status(409).json({ error: 'slug_conflict' });
        throw error;
    }
});

router.post('/:contentId/publish', async (req, res) => {
    const result = await db.query(
        `UPDATE content_pages
         SET status = 'published', published_at = COALESCE(published_at, NOW()), scheduled_at = NULL, updated_by = $2, updated_at = NOW()
         WHERE content_id = $1
         RETURNING ${PUBLIC_COLUMNS}`,
        [req.params.contentId, req.actor.id],
        'org-system'
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    await writeVersion(req.params.contentId, req.actor.id);
    res.json({ page: result.rows[0] });
});

router.post('/:contentId/archive', async (req, res) => {
    const result = await db.query(
        `UPDATE content_pages
         SET status = 'archived', updated_by = $2, updated_at = NOW()
         WHERE content_id = $1
         RETURNING ${PUBLIC_COLUMNS}`,
        [req.params.contentId, req.actor.id],
        'org-system'
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'not_found' });
    await writeVersion(req.params.contentId, req.actor.id);
    res.json({ page: result.rows[0] });
});

module.exports = router;
