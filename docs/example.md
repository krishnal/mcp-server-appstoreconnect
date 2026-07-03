# Example Document

This file is served by the `docs://{+path}` resource template — try reading
`docs://example.md` via `resources/read`.

The template handler sandboxes reads to `DOCS_ROOT` and rejects path
traversal, returning `-32002 Resource not found` for anything outside it.
