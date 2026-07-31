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
