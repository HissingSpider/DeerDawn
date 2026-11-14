# Notes (example add-on)

Short notes the user wants kept, separate from the project brief.

- To save a note: `use_addon { addon: "notes-example", action: "create", args: { collection: "notes", data: { title, body?, tags?, pinned? } } }`.
- To find notes: `read_addon { addon: "notes-example", action: "list", args: { collection: "notes", where: { pinned: true } } }`.
- `where` matches top-level fields exactly; pass an array to match any of several values.
- Notes are personal: nobody else in the workspace can read them, owners included.
