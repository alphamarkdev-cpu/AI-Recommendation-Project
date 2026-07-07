-- Shopify store is the primary SaaS tenant.
-- SHOPIFY_API_KEY and SHOPIFY_API_SECRET stay in .env as app credentials.
-- Merchant/store credentials are created during OAuth and stored per shop_domain here.
create table if not exists shopify_stores (
  id uuid primary key default gen_random_uuid(),
  shop_domain text unique not null,
  access_token text,
  refresh_token text,
  expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  brand_id uuid references brands(brand_id),
  product_category text default 'general',
  primary_color text default '#1B4332',
  scopes text,
  installed_at timestamptz default now(),
  uninstalled_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_shopify_stores_brand_id
  on shopify_stores(brand_id);

create unique index if not exists idx_shopify_stores_shop_domain
  on shopify_stores(shop_domain);

alter table shopify_stores
  add column if not exists refresh_token text,
  add column if not exists expires_at timestamptz,
  add column if not exists refresh_token_expires_at timestamptz,
  add column if not exists product_category text default 'general',
  add column if not exists primary_color text default '#1B4332';

alter table products
  add column if not exists store_id uuid references shopify_stores(id);

alter table brand_question_flows
  add column if not exists store_id uuid references shopify_stores(id);

alter table consumer_sessions
  add column if not exists store_id uuid references shopify_stores(id);

create index if not exists idx_products_store_id
  on products(store_id);

create index if not exists idx_brand_question_flows_store_id
  on brand_question_flows(store_id);

create index if not exists idx_consumer_sessions_store_id
  on consumer_sessions(store_id);
