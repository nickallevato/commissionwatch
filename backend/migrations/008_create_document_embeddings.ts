import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('document_embeddings', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('document_id').notNullable().references('id').inTable('meeting_documents').onDelete('CASCADE');
    table.integer('chunk_index').notNullable().defaultTo(0);
    table.text('chunk_text').notNullable();
    table.string('model').notNullable().defaultTo('pending');
    table.timestamps(true, true);

    table.index('document_id');
  });

  // Add the vector column separately since Knex doesn't have native vector support
  await knex.raw('ALTER TABLE document_embeddings ADD COLUMN embedding vector(1536)');
  await knex.raw('CREATE INDEX idx_document_embeddings_vector ON document_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)');
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('document_embeddings');
}
