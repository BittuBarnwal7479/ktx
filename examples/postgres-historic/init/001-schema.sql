CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

CREATE ROLE app_user LOGIN PASSWORD 'app_pass';
CREATE ROLE etl_user LOGIN PASSWORD 'etl_pass';
CREATE ROLE ktx_reader LOGIN PASSWORD 'ktx_reader';

GRANT pg_read_all_stats TO ktx_reader;

CREATE TABLE customers (
  id integer PRIMARY KEY,
  region text NOT NULL,
  plan text NOT NULL
);

CREATE TABLE orders (
  id integer PRIMARY KEY,
  customer_id integer NOT NULL REFERENCES customers(id),
  status text NOT NULL,
  total numeric(12, 2) NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE events (
  id integer PRIMARY KEY,
  customer_id integer NOT NULL REFERENCES customers(id),
  event_name text NOT NULL,
  occurred_at timestamptz NOT NULL
);

INSERT INTO customers (id, region, plan) VALUES
  (1, 'na', 'enterprise'),
  (2, 'na', 'team'),
  (3, 'eu', 'enterprise'),
  (4, 'apac', 'team');

INSERT INTO orders (id, customer_id, status, total, created_at) VALUES
  (1, 1, 'paid', 125.50, now() - interval '9 days'),
  (2, 1, 'paid', 89.00, now() - interval '4 days'),
  (3, 2, 'pending', 42.00, now() - interval '2 days'),
  (4, 3, 'paid', 301.25, now() - interval '1 day'),
  (5, 4, 'refunded', 77.70, now() - interval '3 hours');

INSERT INTO events (id, customer_id, event_name, occurred_at) VALUES
  (1, 1, 'dashboard_viewed', now() - interval '1 day'),
  (2, 1, 'export_started', now() - interval '8 hours'),
  (3, 2, 'dashboard_viewed', now() - interval '7 hours'),
  (4, 3, 'sync_completed', now() - interval '6 hours'),
  (5, 4, 'dashboard_viewed', now() - interval '5 hours');

GRANT USAGE ON SCHEMA public TO app_user, etl_user, ktx_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_user, etl_user, ktx_reader;
