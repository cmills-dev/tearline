-- 0004_graph.sql : the relationship graph, under the same tenant RLS wall as the rest.
-- Nodes and edges are tenant-scoped; a tenant_private edge (a client's own CRM relationship)
-- is never visible to another tenant. Every edge carries its provenance as jsonb.

create table if not exists graph_node (
  tenant_id             text not null references tenant(id) on delete cascade,
  id                    text not null,
  kind                  text not null,          -- company | person | firm | deal
  firm_role             text,                   -- pe | law | lender | bank | adviser | accountant
  display_name          text not null,
  lei                   text,
  ch_number             text,
  cik                   text,
  oc_id                 text,
  resolution_confidence double precision not null default 0,
  resolution_status     text not null default 'unresolved',
  primary key (tenant_id, id)
);

create table if not exists graph_edge (
  tenant_id      text not null references tenant(id) on delete cascade,
  id             text not null,
  src_id         text not null,
  dst_id         text not null,
  rel            text not null,                 -- advised | financed | sponsored | knows | ...
  assertion_type text not null default 'assertion',
  confidence     double precision not null default 0,
  strength       double precision,
  valid_from     text,
  valid_to       text,
  visibility     text not null default 'shared',  -- shared | tenant_private
  provenance     jsonb not null,
  primary key (tenant_id, id)
);
create index if not exists graph_edge_src on graph_edge(tenant_id, src_id);
create index if not exists graph_edge_dst on graph_edge(tenant_id, dst_id);

-- Row-level security (mirror 0003_rls.sql): scoped to the per-transaction app.tenant_id GUC.
alter table graph_node enable row level security;
alter table graph_node force  row level security;
alter table graph_edge enable row level security;
alter table graph_edge force  row level security;

drop policy if exists graph_node_tenant on graph_node;
create policy graph_node_tenant on graph_node
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));

drop policy if exists graph_edge_tenant on graph_edge;
create policy graph_edge_tenant on graph_edge
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));
