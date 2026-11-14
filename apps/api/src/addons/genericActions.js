'use strict';

// THE ACTIONS EVERY DECLARATIVE ADD-ON GETS, FOR EACH OF ITS COLLECTIONS.
//
// A declarative add-on ships no code, so the platform supplies list / get /
// create / update / remove / count, each taking `collection` in args. They go
// through ctx.records like any server add-on's handler would, so they inherit
// the same person-and-workspace scoping and nothing here can widen it.

const WHERE = {
  type: 'object',
  description: 'Exact match on top-level data fields; an array value matches any of its items.',
  additionalProperties: true,
};

// Over MCP the reply is `text` only unless the caller asks for `data`
// (include_data), so the text has to carry the records themselves: one compact
// JSON line per record, id first.
const recordLine = (row) => `- ${row.id} ${JSON.stringify(row.data)}`;

function genericActions(collectionNames) {
  const collection = { type: 'string', enum: collectionNames, description: 'Which collection.' };
  const id = { type: 'string', minLength: 1, description: 'Record id.' };
  return {
    list: {
      mode: 'read',
      description: 'List records in a collection, newest first. Returns rows and next_cursor.',
      input: {
        type: 'object',
        required: ['collection'],
        additionalProperties: false,
        properties: {
          collection,
          where: WHERE,
          limit: { type: 'number', minimum: 1, maximum: 200 },
          cursor: { type: 'string' },
          order: { type: 'string', enum: ['created_at', '-created_at', 'updated_at', '-updated_at'] },
        },
      },
      handler: async (ctx, args) => {
        const page = await ctx.records.list(args.collection, args);
        if (!page.rows.length) return { text: `No ${args.collection} records match.`, data: page };
        const more = page.next_cursor ? `\nMore: pass cursor "${page.next_cursor}".` : '';
        return {
          text: `${page.rows.length} ${args.collection} record(s):\n${page.rows.map(recordLine).join('\n')}${more}`,
          data: page,
        };
      },
    },
    get: {
      mode: 'read',
      description: 'Read one record by id.',
      input: { type: 'object', required: ['collection', 'id'], additionalProperties: false, properties: { collection, id } },
      handler: async (ctx, args) => {
        const row = await ctx.records.get(args.collection, args.id);
        return row ? { text: recordLine(row), data: { record: row } } : { text: 'No such record.', data: { record: null } };
      },
    },
    create: {
      mode: 'write',
      description: 'Create a record. `data` must match the collection schema.',
      input: {
        type: 'object',
        required: ['collection', 'data'],
        additionalProperties: false,
        properties: { collection, data: { type: 'object' } },
      },
      handler: async (ctx, args) => {
        const row = await ctx.records.create(args.collection, args.data);
        return { text: `Saved ${args.collection} record ${row.id}.`, data: { record: row } };
      },
    },
    update: {
      mode: 'write',
      description: 'Merge `patch` into a record (a null value removes that field).',
      input: {
        type: 'object',
        required: ['collection', 'id', 'patch'],
        additionalProperties: false,
        properties: { collection, id, patch: { type: 'object' } },
      },
      handler: async (ctx, args) => {
        const row = await ctx.records.update(args.collection, args.id, args.patch);
        return row ? { text: `Updated record ${row.id}.`, data: { record: row } } : { text: 'No such record; nothing changed.', data: { record: null } };
      },
    },
    remove: {
      mode: 'write',
      description: 'Delete a record and its attachments.',
      input: { type: 'object', required: ['collection', 'id'], additionalProperties: false, properties: { collection, id } },
      handler: async (ctx, args) => {
        const removed = await ctx.records.remove(args.collection, args.id);
        return { text: removed ? `Deleted record ${args.id}.` : 'No such record; nothing deleted.', data: { removed } };
      },
    },
    count: {
      mode: 'read',
      description: 'Count records in a collection, optionally filtered.',
      input: {
        type: 'object',
        required: ['collection'],
        additionalProperties: false,
        properties: { collection, where: WHERE },
      },
      handler: async (ctx, args) => {
        const count = await ctx.records.count(args.collection, args.where);
        return { text: `${count} ${args.collection} record(s).`, data: { count } };
      },
    },
  };
}

module.exports = { genericActions };
