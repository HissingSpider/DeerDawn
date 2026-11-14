'use strict';

// Compact text renderings. `text` in an action result is what the AI agent
// reads and is charged in tokens, so every line here is written to be short
// and still complete on its own.

function photoIdsOf(data, attached) {
  const removed = new Set(data.removed_photo_ids || []);
  const ids = [];
  for (const id of [...(data.photo_ids || []), ...(attached || [])]) {
    if (id && !removed.has(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function coverOf(data) {
  return photoIdsOf(data)[0] || null;
}

function kindOf(d) {
  if (!d.category) return '?';
  return d.subcategory ? `${d.category}/${d.subcategory}` : d.category;
}

// One closet row, about 25 tokens:
//   i3k9q Navy oxford shirt | top/shirt | navy,white | f3 w2 | active @dorm
function itemLine(row) {
  const d = row.data || {};
  const parts = [
    `${d.ref || row.id} ${d.name || 'Unnamed'}`,
    kindOf(d),
    (d.colors || []).join(',') || '-',
    `f${d.formality ?? '?'} w${d.warmth ?? '?'}`,
    `${d.status || 'active'}${d.location ? ` @${d.location}` : ''}`,
  ];
  if (!d.tags_confirmed) parts.push('unconfirmed');
  return parts.join(' | ');
}

function itemDetail(row, photoIds) {
  const d = row.data || {};
  const lines = [itemLine(row)];
  const extra = [];
  if (d.pattern) extra.push(`pattern ${d.pattern}`);
  if (d.material) extra.push(`material ${d.material}`);
  if ((d.seasons || []).length) extra.push(`seasons ${d.seasons.join(',')}`);
  if (d.fit) extra.push(`fit ${d.fit}`);
  if (d.brand) extra.push(`brand ${d.brand}`);
  if (d.size) extra.push(`size ${d.size}`);
  if (d.acquired) extra.push(`acquired ${d.acquired}`);
  if (d.cost !== undefined && d.cost !== null) extra.push(`cost ${d.cost}`);
  extra.push(`worn ${d.wear_count || 0}x${d.last_worn ? `, last ${d.last_worn}` : ''}`);
  lines.push(extra.join('; '));
  if (d.description) lines.push(`Looks like: ${d.description}`);
  if (d.notes) lines.push(`Notes: ${d.notes}`);
  if (photoIds) lines.push(`Photos: ${photoIds.length}${photoIds.length ? ` (cover ${photoIds[0]})` : ''}`);
  if (!d.tags_confirmed) {
    lines.push(`Tags are a draft${d.tag_source ? ` from ${d.tag_source}` : ''}; confirm with the user.`);
  }
  if (d.tag_error) lines.push(`Tagging problem: ${d.tag_error}`);
  lines.push(`id ${row.id}`);
  return lines.join('\n');
}

function tempRange(d) {
  if (d.temp_min == null && d.temp_max == null) return '';
  return ` ${d.temp_min ?? '?'}-${d.temp_max ?? '?'}C`;
}

function outfitLine(row, refById) {
  const d = row.data || {};
  const items = (d.item_ids || []).map((id) => (refById && refById.get(id)) || 'removed').join(',');
  const styles = (d.styles || []).length ? ` [${d.styles.join(', ')}]` : '';
  const worn = (d.worn_dates || []).length ? ` worn ${d.worn_dates.length}x` : '';
  const why = d.verdict === 'rejected' && d.reason ? ` (${d.reason})` : '';
  return `${d.ref || row.id} "${d.name}"${styles} ${d.verdict}${why}: ${items}${worn}`;
}

function outfitDetail(row, itemRows) {
  const d = row.data || {};
  const lines = [outfitLine(row, new Map(itemRows.map((r) => [r.id, r.data.ref])))];
  const meta = [];
  if ((d.occasions || []).length) meta.push(`occasions ${d.occasions.join(', ')}`);
  if ((d.seasons || []).length) meta.push(`seasons ${d.seasons.join(',')}`);
  const t = tempRange(d);
  if (t) meta.push(`temp${t}`);
  if (d.made_by) meta.push(`made by ${d.made_by}`);
  if ((d.worn_dates || []).length) meta.push(`worn ${d.worn_dates.slice(-5).join(', ')}`);
  if (meta.length) lines.push(meta.join('; '));
  if (d.reason) lines.push(`Reason: ${d.reason}`);
  if (d.request) lines.push(`Asked for: ${d.request}`);
  if (d.notes) lines.push(`Notes: ${d.notes}`);
  lines.push('Items:');
  for (const r of itemRows) lines.push(`- ${itemLine(r)}`);
  const missing = (d.item_ids || []).length - itemRows.length;
  if (missing > 0) lines.push(`- ${missing} item(s) since removed from the closet`);
  lines.push(`id ${row.id}`);
  return lines.join('\n');
}

function styleLine(row, outfitCount) {
  const d = row.data || {};
  const bits = [`${d.name}${outfitCount ? ` (${outfitCount} outfit${outfitCount === 1 ? '' : 's'})` : ''}`];
  if (d.description) bits.push(d.description);
  if ((d.do || []).length) bits.push(`do: ${d.do.join('; ')}`);
  if ((d.dont || []).length) bits.push(`don't: ${d.dont.join('; ')}`);
  if ((d.palette || []).length) bits.push(`palette: ${d.palette.join(', ')}`);
  return bits.join(' | ');
}

module.exports = { itemLine, itemDetail, outfitLine, outfitDetail, styleLine, photoIdsOf, coverOf };
