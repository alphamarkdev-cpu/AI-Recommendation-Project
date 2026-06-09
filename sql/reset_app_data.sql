begin;

truncate table
  public.shopify_stores,
  public.consumer_sessions,
  public.brand_question_flows,
  public.product_match_tags,
  public.product_components,
  public.products,
  public.brands
restart identity cascade;

commit;
