-- Esquema de deposit_db (deposit-service). Generado con pg_dump --schema-only desde la base
-- que crea TypeORM a partir de las entidades (src/entities.ts, synchronize: true).
-- Restaurar en una base vacía:  psql "$DATABASE_URL" -f database/schema.sql

--
-- PostgreSQL database dump
--


-- Dumped from database version 16.15
-- Dumped by pg_dump version 16.15

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


--

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: deposits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deposits (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    reference character varying(64) NOT NULL,
    user_id uuid NOT NULL,
    account_id uuid NOT NULL,
    amount numeric(18,2) NOT NULL,
    amount_in_cents bigint NOT NULL,
    currency character varying(3) DEFAULT 'COP'::character varying NOT NULL,
    status character varying(20) DEFAULT 'PENDING'::character varying NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    wompi_transaction_id character varying(64),
    payment_method_type character varying(30),
    status_message character varying(200),
    ledger_transaction_id uuid,
    credited_at timestamp with time zone,
    last_checked_at timestamp with time zone,
    check_attempts integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: deposits PK_f49ba0cd446eaf7abb4953385d9; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deposits
    ADD CONSTRAINT "PK_f49ba0cd446eaf7abb4953385d9" PRIMARY KEY (id);


--
-- Name: IDX_189a341b5feb2035fb7e462690; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_189a341b5feb2035fb7e462690" ON public.deposits USING btree (status, created_at);


--
-- Name: IDX_31da25657d82c16d495ea2f022; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IDX_31da25657d82c16d495ea2f022" ON public.deposits USING btree (reference);


--
-- Name: IDX_a75e8717ae0def65572a529089; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IDX_a75e8717ae0def65572a529089" ON public.deposits USING btree (wompi_transaction_id) WHERE (wompi_transaction_id IS NOT NULL);


--
-- PostgreSQL database dump complete
--


