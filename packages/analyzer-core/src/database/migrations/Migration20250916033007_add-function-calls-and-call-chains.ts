import { Migration } from '@mikro-orm/migrations';

export class Migration20250916033007AddFunctionCallsAndCallChains extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table "function_calls" ("id" uuid not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, "analysis_run_id" uuid not null, "caller_component_id" uuid not null, "caller_function" varchar(255) not null, "caller_signature" varchar(500) not null, "target_component_id" uuid null, "target_function" varchar(255) not null, "target_signature" varchar(500) null, "line" int not null, "column" int not null, "call_location" varchar(100) not null, "call_type" varchar(50) not null, "argument_count" int not null default 0, "is_async" boolean not null default false, "is_conditional" boolean not null default false, "is_in_loop" boolean not null default false, "is_recursive" boolean not null default false, "arguments" jsonb null, "context" varchar(500) null, "depth" int not null default 0, "frequency" int not null default 1, "metadata" jsonb null, "is_potential_bottleneck" boolean not null default false, "is_hot_path" boolean not null default false, constraint "function_calls_pkey" primary key ("id"));`);
    this.addSql(`create index "function_calls_analysis_run_id_index" on "function_calls" ("analysis_run_id");`);
    this.addSql(`create index "function_calls_caller_component_id_index" on "function_calls" ("caller_component_id");`);
    this.addSql(`create index "function_calls_caller_function_index" on "function_calls" ("caller_function");`);
    this.addSql(`create index "function_calls_target_component_id_index" on "function_calls" ("target_component_id");`);
    this.addSql(`create index "function_calls_target_function_index" on "function_calls" ("target_function");`);
    this.addSql(`alter table "function_calls" add constraint "function_calls_caller_component_id_caller_functio_f0097_unique" unique ("caller_component_id", "caller_function", "target_component_id", "target_function", "call_location");`);

    this.addSql(`create table "call_chains" ("id" uuid not null, "created_at" timestamptz not null, "updated_at" timestamptz not null, "deleted_at" timestamptz null, "analysis_run_id" uuid not null, "chain_id" varchar(255) not null, "chain_type" varchar(50) not null, "entry_component_id" uuid not null, "entry_function" varchar(255) not null, "exit_component_id" uuid null, "exit_function" varchar(255) null, "path" jsonb not null, "length" int not null default 0, "max_depth" int not null default 0, "frequency" int not null default 1, "average_execution_time" real null, "total_execution_time" real null, "is_circular" boolean not null default false, "is_recursive" boolean not null default false, "is_critical" boolean not null default false, "is_hot_path" boolean not null default false, "has_external_calls" boolean not null default false, "has_database_calls" boolean not null default false, "has_async_calls" boolean not null default false, "component_ids" jsonb not null, "component_count" int not null default 0, "function_names" jsonb not null, "unique_function_count" int not null default 0, "complexity" int not null default 0, "risk_level" varchar(20) not null, "risk_factors" jsonb null, "bottlenecks" jsonb null, "business_process" varchar(500) null, "user_action" varchar(500) null, "tags" jsonb null, "ai_description" text null, "metadata" jsonb null, constraint "call_chains_pkey" primary key ("id"));`);
    this.addSql(`create index "call_chains_analysis_run_id_index" on "call_chains" ("analysis_run_id");`);
    this.addSql(`create index "call_chains_chain_id_index" on "call_chains" ("chain_id");`);
    this.addSql(`create index "call_chains_entry_component_id_index" on "call_chains" ("entry_component_id");`);

    this.addSql(`create table "call_chains_function_calls" ("call_chain_id" uuid not null, "function_call_id" uuid not null, constraint "call_chains_function_calls_pkey" primary key ("call_chain_id", "function_call_id"));`);

    this.addSql(`alter table "function_calls" add constraint "function_calls_analysis_run_id_foreign" foreign key ("analysis_run_id") references "analysis_runs" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "function_calls" add constraint "function_calls_caller_component_id_foreign" foreign key ("caller_component_id") references "components" ("id") on update cascade;`);
    this.addSql(`alter table "function_calls" add constraint "function_calls_target_component_id_foreign" foreign key ("target_component_id") references "components" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table "call_chains" add constraint "call_chains_analysis_run_id_foreign" foreign key ("analysis_run_id") references "analysis_runs" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "call_chains" add constraint "call_chains_entry_component_id_foreign" foreign key ("entry_component_id") references "components" ("id") on update cascade;`);
    this.addSql(`alter table "call_chains" add constraint "call_chains_exit_component_id_foreign" foreign key ("exit_component_id") references "components" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table "call_chains_function_calls" add constraint "call_chains_function_calls_call_chain_id_foreign" foreign key ("call_chain_id") references "call_chains" ("id") on update cascade on delete cascade;`);
    this.addSql(`alter table "call_chains_function_calls" add constraint "call_chains_function_calls_function_call_id_foreign" foreign key ("function_call_id") references "function_calls" ("id") on update cascade on delete cascade;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table "call_chains_function_calls" drop constraint "call_chains_function_calls_function_call_id_foreign";`);

    this.addSql(`alter table "call_chains_function_calls" drop constraint "call_chains_function_calls_call_chain_id_foreign";`);

    this.addSql(`drop table if exists "function_calls" cascade;`);

    this.addSql(`drop table if exists "call_chains" cascade;`);

    this.addSql(`drop table if exists "call_chains_function_calls" cascade;`);
  }

}
