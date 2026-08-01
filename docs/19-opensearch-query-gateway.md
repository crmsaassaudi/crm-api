# OpenSearch Query Gateway

`crm-api` owns the permission-aware `GET /api/v1/search` endpoint. It validates
the caller, calculates module permissions, owner/org-unit scope and ABAC
filters, then queries the stable `<prefix>-global-search` OpenSearch alias.

The API does not own:

- OpenSearch Docker or cluster deployment.
- Index mappings and alias migrations.
- MongoDB Change Stream workers.
- Full reindex, retry, DLQ or reconciliation jobs.

Those responsibilities belong to the sibling `crm-opensearch` project. See:

```text
E:\CRM\crm-opensearch\README.md
E:\CRM\crm-opensearch\docs\architecture-vi.md
```

MongoDB remains the source of truth. Set `OPENSEARCH_ENABLED=false` to use the
MongoDB engine exclusively. When enabled, runtime OpenSearch failures may
fallback to MongoDB according to `OPENSEARCH_FALLBACK_TO_MONGODB`; validation,
authentication and authorization failures never fallback.

OpenSearch pagination is snapshot-consistent. The first OpenSearch-backed
module opens one two-minute Point in Time shared by every module in that global
search. The gateway cursor stores that PIT id once and a deterministic
`search_after` triple per module. Later searches chain the latest PIT id
returned by OpenSearch, and the API closes it when no OpenSearch module has a
next page. Abandoned cursors expire automatically. This prevents concurrent
indexing from inserting, skipping, or repeating records between pages without
paying five PIT open/close round trips per keystroke.

Phone-only queries of at least four digits also add an exact `phoneSuffixes`
term clause. The index stores bounded 4–20 digit suffixes for contacts and
accounts, avoiding wildcard scans while supporting caller-ID style lookup.
