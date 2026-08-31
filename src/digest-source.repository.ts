import type { Pool } from 'pg';

export interface DigestSourceIssue {
  digestId: string;
  document: unknown;
}

export interface DigestSourceRepository {
  listForDelivery(publicationDate: string, limit: number): Promise<DigestSourceIssue[]>;
}

export class PgDigestSourceRepository implements DigestSourceRepository {
  constructor(private readonly pool: Pool) {}

  async listForDelivery(publicationDate: string, limit: number): Promise<DigestSourceIssue[]> {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const result = await this.pool.query<{ digest_id: string; document: unknown }>(`
      SELECT source.digest_id, source.document
      FROM digest.telegram_issue_source source
      WHERE source.publication_date = $1::date
        AND NOT EXISTS (
          SELECT 1
          FROM scheduled_publications publication
          WHERE publication.origin_digest_id = source.digest_id
        )
      ORDER BY source.generated_at, source.digest_id
      LIMIT $2
    `, [publicationDate, safeLimit]);
    return result.rows.map((row) => ({
      digestId: row.digest_id,
      document: row.document,
    }));
  }
}
