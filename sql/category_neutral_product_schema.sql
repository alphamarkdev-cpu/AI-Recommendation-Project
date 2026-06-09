begin;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'products'
      and column_name = 'suitable_skin_types'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'products'
      and column_name = 'suitable_customer_attributes'
  ) then
    alter table public.products
      rename column suitable_skin_types to suitable_customer_attributes;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'products'
      and column_name = 'usage_step'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'products'
      and column_name = 'recommendation_step'
  ) then
    alter table public.products
      rename column usage_step to recommendation_step;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'products'
      and column_name = 'time_of_day'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'products'
      and column_name = 'recommended_timing'
  ) then
    alter table public.products
      rename column time_of_day to recommended_timing;
  end if;
end $$;

alter table public.products
  add column if not exists external_product_id text,
  add column if not exists vendor text,
  add column if not exists product_tags text[] default '{}';

do $$
begin
  if to_regclass('public.ingredients') is not null
    and to_regclass('public.product_components') is null then
    alter table public.ingredients rename to product_components;
  end if;

  if to_regclass('public.concern_tags') is not null
    and to_regclass('public.product_match_tags') is null then
    alter table public.concern_tags rename to product_match_tags;
  end if;
end $$;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'product_match_tags'
      and column_name = 'concern'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'product_match_tags'
      and column_name = 'match_tag'
  ) then
    alter table public.product_match_tags
      rename column concern to match_tag;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'product_match_tags'
      and column_name = 'severity_level'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'product_match_tags'
      and column_name = 'intensity_level'
  ) then
    alter table public.product_match_tags
      rename column severity_level to intensity_level;
  end if;
end $$;

commit;
