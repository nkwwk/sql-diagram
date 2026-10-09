export const SAMPLE_SQL = `-- Sample e-commerce schema (PostgreSQL flavoured)

CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name     VARCHAR(120),
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);
COMMENT ON TABLE users IS 'Registered customers and staff';

CREATE TABLE user_profiles (
  user_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  bio        TEXT,
  avatar_url TEXT,
  birthday   DATE
);

CREATE TABLE addresses (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL,
  line1       VARCHAR(200) NOT NULL,
  city        VARCHAR(100) NOT NULL,
  postal_code VARCHAR(20),
  country     CHAR(2) NOT NULL DEFAULT 'GB',
  CONSTRAINT fk_addresses_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE categories (
  id        SERIAL PRIMARY KEY,
  parent_id INT REFERENCES categories(id),
  name      VARCHAR(100) NOT NULL,
  slug      VARCHAR(100) NOT NULL UNIQUE
);

CREATE TABLE products (
  id          BIGSERIAL PRIMARY KEY,
  sku         VARCHAR(40) NOT NULL UNIQUE,
  name        VARCHAR(200) NOT NULL,
  description TEXT,
  price       NUMERIC(10,2) NOT NULL CHECK (price >= 0),
  stock       INT NOT NULL DEFAULT 0
);
COMMENT ON COLUMN products.sku IS 'Stock keeping unit';

CREATE TABLE product_categories (
  product_id  BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  category_id INT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, category_id)
);

CREATE TABLE orders (
  id                  BIGSERIAL PRIMARY KEY,
  user_id             BIGINT NOT NULL REFERENCES users(id),
  shipping_address_id BIGINT REFERENCES addresses(id) ON DELETE SET NULL,
  status              VARCHAR(20) NOT NULL DEFAULT 'pending',
  placed_at           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  order_id   BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  line_no    INT NOT NULL,
  product_id BIGINT NOT NULL REFERENCES products(id),
  quantity   INT NOT NULL CHECK (quantity > 0),
  unit_price NUMERIC(10,2) NOT NULL,
  PRIMARY KEY (order_id, line_no)
);

CREATE TABLE payments (
  id        BIGSERIAL PRIMARY KEY,
  order_id  BIGINT NOT NULL UNIQUE,
  provider  VARCHAR(30) NOT NULL,
  amount    NUMERIC(10,2) NOT NULL,
  paid_at   TIMESTAMP WITH TIME ZONE
);

CREATE TABLE reviews (
  id         BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL,
  user_id    BIGINT,
  rating     SMALLINT NOT NULL,
  body       TEXT
);

ALTER TABLE payments
  ADD CONSTRAINT fk_payments_order FOREIGN KEY (order_id) REFERENCES orders (id);

ALTER TABLE reviews
  ADD CONSTRAINT fk_reviews_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_reviews_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL;
`
