import { Router } from 'express';
import { z } from 'zod';
import { q, tx } from '../db.js';
import { requireRole } from '../auth.js';
import { h, HttpError, paging, clean, slugify, likePattern } from '../http.js';
import { setStatus, ENT, notify } from '../lib/submit.js';

export const admin = Router();
const staff = requireRole('MODERATOR', 'ADMIN');
const adminOnly = requireRole('ADMIN');
const uuid = z.string().uuid();

const audit = (c, adminId, action, entityType, entityId, before, after, note) =>
  c.query('INSERT INTO admin_actions(admin_id, action, entity_type, entity_id, before_state, after_state, note) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [adminId, action, entityType, entityId, before ?? null, after ?? null, note ?? null]);

// Dashboard numbers. "Today" is measured in Lagos time.
admin.get('/admin/stats', staff, h(async (req, res) => {
  const { rows: [s] } = await q(`
    SELECT (SELECT count(*) FROM users)::int AS total_users,
           (SELECT count(*) FROM companies)::int AS total_companies,
           (SELECT count(*) FROM reviews WHERE status = 'APPROVED')::int AS total_reviews,
           (SELECT count(*) FROM gists WHERE status = 'APPROVED')::int AS total_gist_posts,
           (SELECT count(*) FROM salary_reports WHERE status = 'APPROVED')::int AS total_salary_reports,
           (SELECT count(*) FROM interviews WHERE status = 'APPROVED')::int AS total_interview_reports,
           (SELECT count(*) FROM moderation_queue WHERE status IN ('PENDING','ESCALATED'))::int AS pending_moderation,
           (SELECT count(*) FROM moderation_queue WHERE status = 'ESCALATED')::int AS escalated,
           (SELECT count(*) FROM reports WHERE status = 'OPEN')::int AS open_reports,
           (SELECT count(*) FROM users WHERE email_verified_at IS NOT NULL)::int AS verified_users,
           (SELECT count(*) FROM companies WHERE verified_at IS NOT NULL)::int AS verified_companies,
           (SELECT count(*) FROM moderation_queue WHERE created_at >= (date_trunc('day', now() AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos'))::int AS new_submissions_today,
           (SELECT count(DISTINCT user_id) FROM analytics_events WHERE user_id IS NOT NULL AND created_at > now() - interval '7 days')::int AS weekly_active_users`);
  res.json(s);
}));

// Moderation queue: highest risk first, oldest first within a risk level. Includes the text being moderated.
admin.get('/admin/moderation', staff, h(async (req, res) => {
  const { limit, offset, page } = paging(req, 100);
  const status = ['PENDING', 'NEEDS_EDIT', 'ESCALATED', 'APPROVED', 'REJECTED'].includes(req.query.status) ? req.query.status : null;
  const risk = ['LOW', 'MEDIUM', 'HIGH'].includes(req.query.risk) ? req.query.risk : null;
  const { rows } = await q(
    `SELECT id, entity_type, entity_id, status, risk, flags, author_id, auto, decided_by, decided_at, note, created_at
       FROM moderation_queue
      WHERE ($1::moderation_status IS NULL AND status IN ('PENDING','ESCALATED') OR status = $1)
        AND ($2::risk_level IS NULL OR risk = $2)
      ORDER BY (risk = 'HIGH') DESC, (risk = 'MEDIUM') DESC, created_at ASC LIMIT $3 OFFSET $4`, [status, risk, limit, offset]);
  // Fetch the text for each item, one query per entity type (table names come from the ENT whitelist).
  const byType = {};
  rows.forEach((r) => (byType[r.entity_type] ||= []).push(r.entity_id));
  const texts = {};
  for (const [type, ids] of Object.entries(byType)) {
    const { table, text } = ENT[type];
    const { rows: t } = await q(`SELECT id, concat_ws(E'\\n', ${text.join(', ')}) AS content FROM ${table} WHERE id = ANY($1)`, [ids]);
    t.forEach((x) => (texts[x.id] = x.content));
  }
  res.json({ page, limit, items: rows.map((r) => ({ ...r, content: texts[r.entity_id] ?? null })) });
}));

const decision = z.object({
  status: z.enum(['APPROVED', 'REJECTED', 'NEEDS_EDIT', 'ESCALATED']),
  note: z.string().trim().max(500).optional(),
}).refine((d) => d.status === 'APPROVED' || d.status === 'ESCALATED' || !!d.note, { path: ['note'], message: 'Add a short note explaining the decision.' });

admin.post('/admin/moderation/:id/decision', staff, h(async (req, res) => {
  const d = decision.parse(req.body);
  const id = uuid.parse(req.params.id);
  await tx(async (c) => {
    const { rows: [item] } = await c.query('SELECT entity_type, entity_id FROM moderation_queue WHERE id = $1', [id]);
    if (!item) throw new HttpError(404, 'Queue item not found.');
    await setStatus(c, { type: item.entity_type, id: item.entity_id, status: d.status, adminId: req.user.id, note: d.note });
  });
  res.json({ ok: true });
}));

admin.get('/admin/reports', staff, h(async (req, res) => {
  const { limit, offset, page } = paging(req, 100);
  const { rows } = await q(
    `SELECT entity_type, entity_id, count(*)::int AS report_count, array_agg(DISTINCT reason) AS reasons, min(created_at) AS first_reported
       FROM reports WHERE status = 'OPEN' GROUP BY entity_type, entity_id
      ORDER BY count(*) DESC, min(created_at) LIMIT $1 OFFSET $2`, [limit, offset]);
  res.json({ page, limit, items: rows });
}));

// Resolve every open report on an item. ACTIONED can also change the content's moderation status in the same step.
admin.post('/admin/reports/resolve', staff, h(async (req, res) => {
  const d = z.object({
    entityType: z.enum(Object.keys(ENT)), entityId: uuid, outcome: z.enum(['ACTIONED', 'DISMISSED']),
    contentStatus: z.enum(['APPROVED', 'REJECTED', 'NEEDS_EDIT']).optional(), note: z.string().trim().max(500).optional(),
  }).parse(req.body);
  await tx(async (c) => {
    if (d.contentStatus) await setStatus(c, { type: d.entityType, id: d.entityId, status: d.contentStatus, adminId: req.user.id, note: d.note });
    const { rowCount } = await c.query(
      `UPDATE reports SET status = $1, handled_by = $2, handled_at = now(), handler_note = $3
        WHERE entity_type = $4 AND entity_id = $5 AND status = 'OPEN'`, [d.outcome, req.user.id, d.note || null, d.entityType, d.entityId]);
    await audit(c, req.user.id, `REPORTS_${d.outcome}`, d.entityType, d.entityId, null, { reports: rowCount, contentStatus: d.contentStatus ?? null }, d.note);
  });
  res.json({ ok: true });
}));

admin.get('/admin/claims', adminOnly, h(async (req, res) => {
  const { rows } = await q(
    `SELECT cl.id, c.slug AS company_slug, c.name AS company_name, cl.user_id, cl.work_email_domain, cl.role_title, cl.evidence_note, cl.evidence_ref, cl.status, cl.created_at
       FROM company_claims cl JOIN companies c ON c.id = cl.company_id
      WHERE cl.status = 'PENDING' ORDER BY cl.created_at LIMIT 100`);
  res.json(rows);
}));

admin.post('/admin/claims/:id/decision', adminOnly, h(async (req, res) => {
  const d = z.object({ status: z.enum(['APPROVED', 'REJECTED']), note: z.string().trim().max(500).optional() }).parse(req.body);
  const id = uuid.parse(req.params.id);
  await tx(async (c) => {
    const { rows: [cl] } = await c.query(`UPDATE company_claims SET status = $1, reviewed_by = $2, reviewed_at = now(), decision_note = $3 WHERE id = $4 AND status = 'PENDING' RETURNING company_id, user_id`, [d.status, req.user.id, d.note || null, id]);
    if (!cl) throw new HttpError(404, 'No pending claim with that id.');
    if (d.status === 'APPROVED') {
      await c.query('INSERT INTO company_members(company_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [cl.company_id, cl.user_id]);
      await c.query(`UPDATE users SET role = 'COMPANY_REP' WHERE id = $1 AND role = 'USER'`, [cl.user_id]);
      await c.query('UPDATE companies SET verified_at = COALESCE(verified_at, now()) WHERE id = $1', [cl.company_id]);
    }
    await audit(c, req.user.id, `CLAIM_${d.status}`, 'COMPANY', cl.company_id, { status: 'PENDING' }, { status: d.status, claimant: cl.user_id }, d.note);
    await notify(c, cl.user_id, `CLAIM_${d.status}`, { companyId: cl.company_id });
  });
  res.json({ ok: true });
}));

admin.get('/admin/audit', adminOnly, h(async (req, res) => {
  const { limit, offset, page } = paging(req, 100);
  const { rows } = await q('SELECT id, admin_id, action, entity_type, entity_id, before_state, after_state, note, created_at FROM admin_actions ORDER BY id DESC LIMIT $1 OFFSET $2', [limit, offset]);
  res.json({ page, limit, items: rows });
}));

// Suspend or reinstate an account. Content stays; the user simply cannot sign in or post.
admin.post('/admin/users/:id/status', adminOnly, h(async (req, res) => {
  const d = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']), note: z.string().trim().min(3).max(500) }).parse(req.body);
  const id = uuid.parse(req.params.id);
  await tx(async (c) => {
    const { rows: [u] } = await c.query('UPDATE users SET status = $1 WHERE id = $2 AND role = \'USER\' RETURNING id', [d.status, id]);
    if (!u) throw new HttpError(404, 'User not found, or not a regular user.');
    if (d.status === 'SUSPENDED') await c.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
    await audit(c, req.user.id, `USER_${d.status}`, 'USER', id, null, { status: d.status }, d.note);
  });
  res.json({ ok: true });
}));

// ---------- companies (admin) ----------
const text = (min, max) => z.string().transform(clean).pipe(z.string().min(min).max(max));
const httpUrl = z.string().trim().url().max(200).refine((u) => /^https?:\/\//i.test(u), 'Use a web address starting with http:// or https://');
const BANDS = ['1-10', '11-50', '51-200', '201-500', '501-1,000', '1,001-5,000', '5,000+'];

const companySchema = z.object({
  name: text(2, 100),
  industry: text(2, 60),                       // matched to an existing industry by name, or created
  website: httpUrl.optional(),
  description: text(0, 1500).optional(),
  employeeBand: z.enum(BANDS).optional(),
  locations: z.array(z.object({ city: text(2, 60), state: text(0, 60).optional(), isHq: z.boolean().default(false) })).min(1).max(10),
  force: z.boolean().default(false),           // add even if a similar name exists
});

async function ensureIndustry(c, name) {
  const { rows: [hit] } = await c.query('SELECT id FROM industries WHERE lower(name) = lower($1)', [name]);
  if (hit) return hit.id;
  const slug = slugify(name);
  if (!slug) throw new HttpError(422, 'Enter a valid industry name.');
  // If the slug already exists under a slightly different name ("Oil & Gas" vs "Oil and Gas"), reuse it.
  const { rows: [row] } = await c.query('INSERT INTO industries(slug, name) VALUES ($1,$2) ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug RETURNING id', [slug, name]);
  return row.id;
}

async function uniqueSlug(c, name) {
  const base = slugify(name);
  if (!base) throw new HttpError(422, 'Enter a valid company name.');
  for (let i = 1; i <= 50; i++) {
    const s = i === 1 ? base : `${base}-${i}`;
    const { rows } = await c.query('SELECT 1 FROM companies WHERE slug = $1', [s]);
    if (!rows.length) return s;
  }
  throw new HttpError(409, 'Could not make a unique web address for this company.');
}

async function createCompany(c, d, adminId) {
  if (!d.force) {
    const { rows: similar } = await c.query(
      `SELECT slug, name FROM companies WHERE lower(name) = lower($1) OR similarity(name, $1) >= 0.6 ORDER BY similarity(name, $1) DESC LIMIT 5`, [d.name]);
    if (similar.length) throw new HttpError(409, 'A similar company already exists.', { similar });
  }
  const industryId = await ensureIndustry(c, d.industry);
  const slug = await uniqueSlug(c, d.name);
  const { rows: [co] } = await c.query(
    `INSERT INTO companies(slug, name, industry_id, description, website, employee_band, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, slug`,
    [slug, d.name, industryId, d.description || null, d.website || null, d.employeeBand || null, adminId]);
  for (const [i, l] of d.locations.entries())
    await c.query('INSERT INTO company_locations(company_id, city, state, is_hq) VALUES ($1,$2,$3,$4)', [co.id, l.city, l.state || null, l.isHq || i === 0]);
  await audit(c, adminId, 'COMPANY_CREATED', 'COMPANY', co.id, null, { name: d.name, slug }, null);
  return co.slug;
}

admin.get('/admin/companies', adminOnly, h(async (req, res) => {
  const { limit, offset, page } = paging(req, 100);
  const search = String(req.query.q || '').trim().slice(0, 80);
  const { rows } = await q(
    `SELECT c.slug, c.name, i.name AS industry, c.status, c.is_demo, (c.verified_at IS NOT NULL) AS verified, c.review_count, c.avg_rating, c.created_at,
            (SELECT l.city FROM company_locations l WHERE l.company_id = c.id ORDER BY l.is_hq DESC, l.city LIMIT 1) AS city
       FROM companies c LEFT JOIN industries i ON i.id = c.industry_id
      WHERE ($1::text IS NULL OR c.name ILIKE $1)
      ORDER BY c.is_demo ASC, c.created_at DESC LIMIT $2 OFFSET $3`, [search ? likePattern(search) : null, limit, offset]);
  res.json({ page, limit, items: rows });
}));

admin.post('/admin/companies', adminOnly, h(async (req, res) => {
  const d = companySchema.parse(req.body);
  const slug = await tx((c) => createCompany(c, d, req.user.id));
  res.status(201).json({ slug });
}));

// Bulk add: each row succeeds or fails on its own, so one bad row never blocks the rest. Similar names are skipped, not guessed at.
admin.post('/admin/companies/bulk', adminOnly, h(async (req, res) => {
  const { rows } = z.object({ rows: z.array(z.object({
    name: z.string(), industry: z.string(), city: z.string(), state: z.string().optional(), website: z.string().optional(),
  })).min(1).max(100) }).parse(req.body);
  const results = [];
  for (const [i, r] of rows.entries()) {
    const parsed = companySchema.safeParse({
      name: r.name, industry: r.industry, website: r.website || undefined,
      locations: [{ city: r.city, state: r.state || undefined, isHq: true }],
    });
    if (!parsed.success) { results.push({ row: i + 1, name: r.name, status: 'error', message: parsed.error.issues[0].path.join('.') + ': ' + parsed.error.issues[0].message }); continue; }
    try {
      const slug = await tx((c) => createCompany(c, parsed.data, req.user.id));
      results.push({ row: i + 1, name: r.name, status: 'created', slug });
    } catch (e) {
      if (e instanceof HttpError && e.status === 409 && e.extra.similar) results.push({ row: i + 1, name: r.name, status: 'skipped', message: `Similar to "${e.extra.similar[0].name}"` });
      else results.push({ row: i + 1, name: r.name, status: 'error', message: e instanceof HttpError ? e.message : 'Unexpected error' });
    }
  }
  res.json({ results });
}));

// Edit basics, or hide/show a company (hidden companies disappear from the public site; nothing is deleted).
admin.patch('/admin/companies/:slug', adminOnly, h(async (req, res) => {
  const d = z.object({
    description: text(0, 1500).optional(), website: httpUrl.optional(), employeeBand: z.enum(BANDS).optional(),
    industry: text(2, 60).optional(), status: z.enum(['ACTIVE', 'HIDDEN']).optional(),
  }).parse(req.body);
  await tx(async (c) => {
    const { rows: [before] } = await c.query('SELECT id, description, website, employee_band, industry_id, status FROM companies WHERE slug = $1 FOR UPDATE', [req.params.slug]);
    if (!before) throw new HttpError(404, 'Company not found.');
    const industryId = d.industry ? await ensureIndustry(c, d.industry) : null;
    await c.query(
      `UPDATE companies SET description = COALESCE($1, description), website = COALESCE($2, website), employee_band = COALESCE($3, employee_band),
              industry_id = COALESCE($4, industry_id), status = COALESCE($5, status) WHERE id = $6`,
      [d.description ?? null, d.website ?? null, d.employeeBand ?? null, industryId, d.status ?? null, before.id]);
    await audit(c, req.user.id, d.status ? `COMPANY_${d.status}` : 'COMPANY_EDITED', 'COMPANY', before.id, before, d, null);
  });
  res.json({ ok: true });
}));

// ---------- company suggestions (admin) ----------
admin.get('/admin/suggestions', adminOnly, h(async (req, res) => {
  const { rows } = await q(`SELECT id, name, industry, city, state, website, created_at FROM company_suggestions WHERE status = 'PENDING' ORDER BY created_at LIMIT 100`);
  // Show likely duplicates next to each suggestion so a reviewer does not add the same company twice.
  const items = await Promise.all(rows.map(async (s) => ({
    ...s,
    similar: (await q(`SELECT slug, name FROM companies WHERE similarity(name, $1) >= 0.4 ORDER BY similarity(name, $1) DESC LIMIT 3`, [s.name])).rows,
  })));
  res.json(items);
}));

// Approve (optionally correcting the details first) or reject. Approving creates the real company and tells the person who suggested it.
admin.post('/admin/suggestions/:id/decision', adminOnly, h(async (req, res) => {
  const d = z.object({
    status: z.enum(['APPROVED', 'REJECTED']),
    note: z.string().trim().max(300).optional(),
    edits: z.object({ name: text(2, 100).optional(), industry: text(2, 60).optional(), city: text(2, 60).optional(), state: text(0, 60).optional(), website: httpUrl.optional() }).optional(),
  }).parse(req.body);
  const id = uuid.parse(req.params.id);
  const out = await tx(async (c) => {
    const { rows: [s] } = await c.query(`SELECT * FROM company_suggestions WHERE id = $1 AND status = 'PENDING' FOR UPDATE`, [id]);
    if (!s) throw new HttpError(404, 'No pending suggestion with that id.');
    const e = d.edits || {};
    let slug = null;
    if (d.status === 'APPROVED') {
      slug = await createCompany(c, {
        name: e.name ?? s.name, industry: e.industry ?? s.industry, website: e.website ?? s.website ?? undefined,
        locations: [{ city: e.city ?? s.city, state: (e.state ?? s.state) || undefined, isHq: true }], force: true,   // an admin has already looked at it
      }, req.user.id);
    }
    await c.query(`UPDATE company_suggestions SET status = $1, decided_by = $2, decided_at = now(), note = $3, company_slug = $4 WHERE id = $5`,
      [d.status, req.user.id, d.note || null, slug, id]);
    await audit(c, req.user.id, `SUGGESTION_${d.status}`, 'COMPANY_SUGGESTION', id, { name: s.name }, { slug }, d.note);
    await notify(c, s.user_id, `SUGGESTION_${d.status}`, { name: e.name ?? s.name, slug });
    return { slug };
  });
  res.json(out);
}));

// ---------- sample (demo) data ----------
// Everything seeded as sample content carries is_demo = true, so it can be told apart from real contributions.
const DEMO_IDS = `
  SELECT 'REVIEW'::entity_type AS t, id FROM reviews WHERE is_demo
  UNION ALL SELECT 'GIST'::entity_type, id FROM gists WHERE is_demo
  UNION ALL SELECT 'GIST_COMMENT'::entity_type, id FROM gist_comments WHERE is_demo
  UNION ALL SELECT 'SALARY_REPORT'::entity_type, id FROM salary_reports WHERE is_demo
  UNION ALL SELECT 'INTERVIEW'::entity_type, id FROM interviews WHERE is_demo`;

admin.get('/admin/demo', adminOnly, h(async (req, res) => {
  const { rows: [r] } = await q(`
    SELECT (SELECT count(*) FROM companies WHERE is_demo)::int AS companies,
           (SELECT count(*) FROM reviews WHERE is_demo)::int AS reviews,
           (SELECT count(*) FROM gists WHERE is_demo)::int AS gists,
           (SELECT count(*) FROM gist_comments WHERE is_demo)::int AS comments,
           (SELECT count(*) FROM salary_reports WHERE is_demo)::int AS salaries,
           (SELECT count(*) FROM interviews WHERE is_demo)::int AS interviews,
           (SELECT count(*) FROM companies c WHERE c.is_demo AND (
               EXISTS (SELECT 1 FROM reviews x WHERE x.company_id = c.id AND NOT x.is_demo)
            OR EXISTS (SELECT 1 FROM salary_reports x WHERE x.company_id = c.id AND NOT x.is_demo)
            OR EXISTS (SELECT 1 FROM interviews x WHERE x.company_id = c.id AND NOT x.is_demo)))::int AS companies_with_real_content`);
  res.json(r);
}));

// Permanently removes all sample content. Real contributions are never touched.
// A sample company that real people have already written about is hidden instead of deleted.
admin.post('/admin/demo/purge', adminOnly, h(async (req, res) => {
  z.object({ confirm: z.literal('REMOVE') }).parse(req.body);
  const out = await tx(async (c) => {
    await c.query(`WITH d AS (${DEMO_IDS}) DELETE FROM moderation_queue m USING d WHERE m.entity_type = d.t AND m.entity_id = d.id`);
    await c.query(`WITH d AS (${DEMO_IDS}) DELETE FROM reports r USING d WHERE r.entity_type = d.t AND r.entity_id = d.id`);
    const deleted = {};
    for (const table of ['reviews', 'gists', 'gist_comments', 'salary_reports', 'interviews'])
      deleted[table] = (await c.query(`DELETE FROM ${table} WHERE is_demo`)).rowCount;
    const { rowCount: companiesRemoved } = await c.query(
      `DELETE FROM companies c WHERE c.is_demo
          AND NOT EXISTS (SELECT 1 FROM reviews x WHERE x.company_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM salary_reports x WHERE x.company_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM interviews x WHERE x.company_id = c.id)`);
    const { rowCount: companiesHidden } = await c.query(`UPDATE companies SET status = 'HIDDEN' WHERE is_demo AND status = 'ACTIVE'`);
    const result = { ...deleted, companiesRemoved, companiesHidden };
    await audit(c, req.user.id, 'DEMO_DATA_PURGED', 'SYSTEM', null, null, result, null);
    return result;
  });
  res.json(out);
}));
