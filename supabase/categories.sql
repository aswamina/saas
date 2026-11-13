-- Run this once in the Supabase SQL editor.
-- Creates the `categories` table, fills it with LinkedIn's top-level industry
-- groups (LinkedIn Industry Codes V2) plus Travel and Tourism, and adds a `category` column to `ideas`
-- so each saved idea remembers which category it was generated for.

create table if not exists categories (
  category_id smallint generated always as identity primary key,
  name text not null unique,
  sort_order smallint not null default 0
);

insert into categories (name, sort_order) values
  ('Accommodation Services', 1),
  ('Administrative and Support Services', 2),
  ('Construction', 3),
  ('Consumer Services', 4),
  ('Education', 5),
  ('Entertainment Providers', 6),
  ('Farming, Ranching, Forestry', 7),
  ('Financial Services', 8),
  ('Government Administration', 9),
  ('Holding Companies', 10),
  ('Hospitals and Health Care', 11),
  ('Manufacturing', 12),
  ('Oil, Gas, and Mining', 13),
  ('Professional Services', 14),
  ('Real Estate and Equipment Rental Services', 15),
  ('Retail', 16),
  ('Technology, Information and Media', 17),
  ('Transportation, Logistics, Supply Chain and Storage', 18),
  -- Not a top-level LinkedIn group (LinkedIn splits travel across Accommodation,
  -- Transportation and Administrative Services), added as its own category.
  ('Travel and Tourism', 19),
  ('Utilities', 20),
  ('Wholesale', 21)
on conflict (name) do nothing;

-- The category name each idea was generated for (null = no category chosen).
alter table ideas add column if not exists category text;
