import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("anomaly_flags", (table) => {
    table
      .uuid("agenda_item_id")
      .nullable()
      .references("id")
      .inTable("agenda_items")
      .onDelete("CASCADE");
    table.string("source", 10).notNullable().defaultTo("auto");
    table.index("agenda_item_id");
  });

  await knex.schema.createTable("detection_runs", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table
      .uuid("meeting_id")
      .notNullable()
      .references("id")
      .inTable("meetings")
      .onDelete("CASCADE");
    table.integer("flags_created").notNullable().defaultTo(0);
    table.string("rules_version", 20).notNullable();
    table.timestamp("started_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("completed_at", { useTz: true }).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("detection_runs");
  await knex.schema.alterTable("anomaly_flags", (table) => {
    table.dropColumn("agenda_item_id");
    table.dropColumn("source");
  });
}
