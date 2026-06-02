create table if not exists shopify_stores (
  id uuid primary key default gen_random_uuid(),
  shop_domain text unique not null,
  access_token text,
  brand_id uuid references brands(brand_id),
  scopes text,
  installed_at timestamptz default now(),
  uninstalled_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_shopify_stores_brand_id
  on shopify_stores(brand_id);
