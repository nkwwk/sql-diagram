/** Realistic dump-style fixtures for each supported dialect. */

export const MYSQL_DUMP = `-- MySQL dump 10.13  Distrib 8.0.36, for Linux (x86_64)
--
-- Host: localhost    Database: shop
/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET NAMES utf8mb4 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;

DROP TABLE IF EXISTS \`authors\`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
CREATE TABLE \`authors\` (
  \`id\` int(11) unsigned NOT NULL AUTO_INCREMENT,
  \`name\` varchar(100) CHARACTER SET utf8mb4 NOT NULL DEFAULT '' COMMENT 'Author''s name; full',
  \`status\` enum('active','retired') DEFAULT 'active',
  \`updated\` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`),
  KEY \`idx_name\` (\`name\`)
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COMMENT='Book authors';

LOCK TABLES \`authors\` WRITE;
/*!40000 ALTER TABLE \`authors\` DISABLE KEYS */;
INSERT INTO \`authors\` VALUES (1,'O\\'Brien; \\"Pat\\"','active','2024-01-01 00:00:00'),(2,'-- not a comment /* nor this','retired',NULL);
/*!40000 ALTER TABLE \`authors\` ENABLE KEYS */;
UNLOCK TABLES;

DROP TABLE IF EXISTS \`books\`;
CREATE TABLE \`books\` (
  \`id\` int NOT NULL,
  \`author_id\` int unsigned DEFAULT NULL,
  \`isbn\` char(13) NOT NULL,
  \`price\` decimal(10,2),
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uq_isbn\` (\`isbn\`),
  CONSTRAINT \`fk_author\` FOREIGN KEY (\`author_id\`) REFERENCES \`authors\` (\`id\`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB;

INSERT INTO \`books\` VALUES (1,1,'9780000000001',9.99),(2,2,'9780000000002',19.50);
ALTER TABLE \`books\` MODIFY \`id\` int NOT NULL AUTO_INCREMENT;

DELIMITER ;;
CREATE TRIGGER \`books_bi\` BEFORE INSERT ON \`books\` FOR EACH ROW BEGIN
  SET NEW.isbn = TRIM(NEW.isbn);
  INSERT INTO audit VALUES ('create table nope (x int);');
END ;;
DELIMITER ;

CREATE TABLE \`book_tags\` (
  \`book_id\` int NOT NULL,
  \`tag\` varchar(40) NOT NULL,
  PRIMARY KEY (\`book_id\`,\`tag\`),
  CONSTRAINT \`fk_bt_book\` FOREIGN KEY (\`book_id\`) REFERENCES \`books\` (\`id\`)
);
`

export const PG_DUMP = `--
-- PostgreSQL database dump
--
SET statement_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);

CREATE FUNCTION public.touch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at := now(); -- semicolons; everywhere;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.tagged() RETURNS text LANGUAGE sql AS $fn$ SELECT 'CREATE TABLE fake (id int);' || $$x;$$ $fn$;

CREATE TABLE public.customers (
    id integer NOT NULL,
    email character varying(255) NOT NULL,
    "Display Name" text,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);

COMMENT ON TABLE public.customers IS 'People who buy things';
COMMENT ON COLUMN public.customers.email IS 'Login e-mail';

CREATE SEQUENCE public.customers_id_seq
    AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

CREATE TABLE public.orders (
    id bigint NOT NULL,
    customer_id integer,
    note text DEFAULT 'n/a'::text
);

CREATE TABLE sales.invoices (
    id bigint NOT NULL,
    order_id bigint NOT NULL
);

ALTER TABLE ONLY public.customers ALTER COLUMN id SET DEFAULT nextval('public.customers_id_seq'::regclass);

COPY public.customers (id, email, "Display Name", created_at) FROM stdin;
1	a@example.com	Alice; the "first"	2024-01-01 00:00:00
2	b@example.com	CREATE TABLE nope (x int);	2024-01-02 00:00:00
3	c@example.com	it's \\N quoted '	2024-01-03 00:00:00
\\.

INSERT INTO public.orders VALUES (1, 1, 'C:\\');

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (id);
ALTER TABLE ONLY sales.invoices
    ADD CONSTRAINT invoices_pkey PRIMARY KEY (id);
CREATE UNIQUE INDEX customers_email_key ON public.customers USING btree (email);
ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;
ALTER TABLE ONLY sales.invoices
    ADD CONSTRAINT invoices_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id);
`

export const MSSQL_SCRIPT = `USE [Shop]
GO
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[Customers](
\t[CustomerID] [int] IDENTITY(1,1) NOT NULL,
\t[Name] [nvarchar](50) NULL,
\t[Path] [nvarchar](max) NULL,
 CONSTRAINT [PK_Customers] PRIMARY KEY CLUSTERED
(
\t[CustomerID] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF) ON [PRIMARY]
) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY]
GO
INSERT [dbo].[Customers] ([CustomerID], [Name], [Path]) VALUES (1, N'Ann', N'C:\\')
INSERT [dbo].[Customers] ([CustomerID], [Name], [Path]) VALUES (2, N'Bo''b', N'D:\\data\\')
GO
CREATE TABLE [sales].[Orders](
\t[OrderID] [int] NOT NULL,
\t[CustomerID] [int] NOT NULL,
\t[Total] [decimal](18, 2) NULL,
 CONSTRAINT [PK_Orders] PRIMARY KEY CLUSTERED ([OrderID] ASC)
) ON [PRIMARY]
GO
ALTER TABLE [sales].[Orders]  WITH CHECK ADD  CONSTRAINT [FK_Orders_Customers] FOREIGN KEY([CustomerID])
REFERENCES [dbo].[Customers] ([CustomerID])
GO
ALTER TABLE [sales].[Orders] CHECK CONSTRAINT [FK_Orders_Customers]
GO
`

export const SQLITE_DUMP = `PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE artists(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
INSERT INTO artists VALUES(1,'AC\\DC');
INSERT INTO artists VALUES(2,'Guns ''n'' Roses');
CREATE TABLE "albums"("id" INTEGER PRIMARY KEY, "artist_id" INTEGER NOT NULL REFERENCES "artists", "parent_id" INTEGER REFERENCES "albums"("id"), "title" TEXT);
DELETE FROM sqlite_sequence;
INSERT INTO sqlite_sequence VALUES('artists',2);
COMMIT;
`
