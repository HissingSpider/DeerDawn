# Add-ons

An add-on gives your agent a new kind of memory that does not belong in a
project brief: a closet of clothes, a reading list, a set of recipes. Its data
lives in its own store, private to you, and your agent reaches it through two
fixed MCP tools:

- `read_addon { addon, action, args }` runs a read action. It cannot change anything.
- `use_addon { addon, action, args }` runs any action, writes included.

`read_addon { addon: "<id>", action: "help" }` returns the add-on's
instructions and every action with its argument schema. That is how the agent
learns an add-on, so the tool list stays the same size however many add-ons
are installed.

A workspace switches add-ons on at **Add-ons** in the dashboard (`/addons`).
In a team workspace only an owner can switch one on or off. What an add-on
stores is always personal: nobody else in the workspace can read it, workspace
owners included.

## Writing one

An add-on is a directory under `addons/` whose name is its id:

```
addons/notes-example/
  addon.json          the manifest
  SKILL.md            instructions for the agent
  schemas/note.json   a JSON Schema per collection
  index.js            server add-ons only
```

The smallest complete example is [`addons/notes-example`](../addons/notes-example).

### The manifest (`addon.json`)

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | 2 to 40 characters: lowercase letters, digits, hyphens. Must equal the directory name. |
| `name` | yes | Shown in the dashboard. |
| `version` | yes | Semantic version, e.g. `0.1.0`. |
| `description` | no | One or two sentences. |
| `kind` | yes | `"declarative"` (data only) or `"server"` (ships `index.js`). |
| `collections` | yes | Map of collection name to `{ "schema": "<relative path>", "attachments": true }`. `attachments` lets records in that collection carry images. |
| `skill` | no | Relative path to a markdown file. Returned by `help`. |
| `brief_line` | no | One line for the session brief. `{{<collection>.count}}` is the only substitution, e.g. `"Notes: {{notes.count}} saved"`. It counts **every** record the person has in that collection; there is no filter, so word the line to match (for instance "84 items", not "84 active items"). |
| `views` | no | For the dashboard's generic page: `{ "id", "type": "gallery" \| "table" \| "detail", "collection", "title"?, "fields"?, "title_field"? }`. |
| `default_visibility` | no | `"personal"`, the only value in this version. |

The JSON Schema for the manifest itself, and a validator, are in
[`packages/addon-kit`](../packages/addon-kit) (MIT):

```js
const { validateManifest } = require('@deerdawn/addon-kit');
const { ok, errors } = validateManifest(require('./addon.json'));
```

A manifest that does not validate, a schema that does not compile, or an
`index.js` that throws when loaded makes the server skip that add-on and log
why. It never stops the server from starting.

### Declarative add-ons

A declarative add-on is only data, and the platform supplies its actions, for
every collection:

| Action | Mode | Args |
|---|---|---|
| `list` | read | `collection`, `where?`, `limit?` (max 200), `cursor?`, `order?` |
| `get` | read | `collection`, `id` |
| `count` | read | `collection`, `where?` |
| `create` | write | `collection`, `data` (must match the collection schema) |
| `update` | write | `collection`, `id`, `patch` (merged; a `null` value removes that field) |
| `remove` | write | `collection`, `id` (also deletes the record's attachments) |

`where` is a flat map of top-level fields to a value, or to an array of values
meaning any of them. It is evaluated after decryption, over at most 5,000 rows
per call; `next_cursor` continues a list that stopped early.

### Server add-ons

A server add-on also ships `index.js`, a CommonJS module exporting its actions:

```js
module.exports = {
  actions: {
    summary: {
      mode: 'read',
      description: 'How many notes, and the newest one.',
      input: { type: 'object', properties: {} },
      handler: async (ctx) => {
        const n = await ctx.records.count('notes');
        const { rows } = await ctx.records.list('notes', { limit: 1 });
        return { text: `${n} notes. Newest: ${rows[0]?.data.title || 'none'}.`, data: { count: n } };
      },
    },
  },
};
```

A handler returns `{ text, data?, images? }`, where `images` is
`[{ mime, base64 }]` (shown by MCP clients that display images). Put what the
agent needs in `text`: over MCP the reply is `text` and images only, and `data`
is added only when the caller passes `include_data: true` in `args` (or the
action returned no text). The dashboard, over HTTP, always gets `data`. It receives
`ctx`:

| `ctx` | What it is |
|---|---|
| `ownerKey`, `personId`, `addonId`, `transport`, `actor` | Who is calling and through what. |
| `records` | `list`, `get`, `create`, `update`, `remove`, `count`. Always scoped to the calling person and workspace; a handler cannot widen it. |
| `attachments` | `listFor(collection, recordId)`, `read(id, variant)`, `signedUrl(id, variant, ttl)`, `createUploadLink({ collection })`, `ingest({ collection, recordId?, buffer, filename })`. |
| `llm` | `{ describeImage(buffer, prompt) }`, or `null` when the server has no vision model (`LLM_VISION_MODEL`). |
| `log(message, fields?)` | Server log line, prefixed with the add-on id. |

A `read` action's `ctx` refuses writes, so `read_addon` stays read-only for
every add-on.

### Images

Uploads go through the dashboard, an upload link the agent creates
(`ctx.attachments.createUploadLink`, valid 15 minutes, bound to one person), or
`ctx.attachments.ingest`. The server reads the real type from the file's bytes
(JPEG, PNG, WebP, and HEIC/HEIF as iPhones write them), strips all metadata
including location, applies the orientation, and stores a 256px and a 1024px
WebP plus the cleaned original. A HEIC original is stored as JPEG, so nothing
that reads it later needs a HEIC decoder. HEIC is decoded by libheif compiled to
WebAssembly (`libheif-js`, LGPL-3.0), loaded only when a HEIC arrives; it needs
no system packages, and a 12-megapixel photo takes a few seconds.

## Running add-ons on your own server

| Variable | Default | Meaning |
|---|---|---|
| `DEERDAWN_ADDONS` | every add-on in `addons/` | Comma-separated allowlist. `none` loads nothing. |
| `ADDON_STORAGE_DIR` | `/data/addons` when self-hosted | Where images are stored on disk. |
| `ADDON_S3_BUCKET`, `ADDON_S3_ENDPOINT`, `ADDON_S3_REGION`, `ADDON_S3_ACCESS_KEY_ID`, `ADDON_S3_SECRET_ACCESS_KEY` | unset | Use an S3-compatible store instead of disk. |
| `ADDON_MAX_UPLOAD_BYTES` | none self-hosted | Largest single file. |
| `ADDON_MAX_ATTACHMENTS_PER_PERSON` | none self-hosted | Files per person. |
| `ADDON_MAX_BYTES_PER_PERSON` | none self-hosted | Stored bytes per person. |
| `LLM_VISION_MODEL` | unset | A vision model on your `LLM_API_URL` server, for `ctx.llm.describeImage`. |

The self-hosted `docker-compose.yml` mounts a volume at `/data/addons`.

## What happens to the data

Records are encrypted at rest with your workspace key whenever
`ENCRYPTION_MASTER_KEY` is set, like briefs. Image files are stored as private
objects and are not covered by that encryption.

The account export (`GET /api/v1/context/export`, or "Your data" in the
dashboard) includes your add-on records and a list of your files, each with the
path to download it. Deleting your account, or being removed from a workspace,
deletes your add-on records and files there.

## Licensing

The add-on interface (`packages/addon-kit`, the manifest format and its
schemas) is MIT. An add-on that is only data is yours to license however you
like. An add-on that ships code running inside the AGPL-licensed server is a
different case; see [LICENSING.md](../LICENSING.md).
