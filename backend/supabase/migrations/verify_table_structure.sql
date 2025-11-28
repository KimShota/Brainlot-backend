-- Verification queries for user_subscriptions and user_usage_stats tables
-- Run these queries in Supabase SQL Editor to verify your table structure

-- ============================================
-- 1. Check user_subscriptions table structure
-- ============================================
SELECT 
    column_name,
    data_type,
    is_nullable,
    column_default
FROM information_schema.columns
WHERE table_schema = 'public' 
  AND table_name = 'user_subscriptions'
ORDER BY ordinal_position;

-- Expected columns:
-- id (uuid, NOT NULL, PRIMARY KEY)
-- user_id (uuid, NOT NULL, FOREIGN KEY to auth.users)
-- plan_type (text, NOT NULL, CHECK constraint: 'free' or 'pro')
-- status (text, NOT NULL, CHECK constraint: 'active', 'cancelled', or 'expired')
-- revenue_cat_customer_id (text, nullable)
-- revenue_cat_subscription_id (text, nullable) ⭐ IMPORTANT: Make sure this exists!
-- started_at (timestamptz, nullable)
-- expires_at (timestamptz, nullable)
-- created_at (timestamptz, NOT NULL)
-- updated_at (timestamptz, NOT NULL)

-- ============================================
-- 2. Check constraints on user_subscriptions
-- ============================================
SELECT 
    conname AS constraint_name,
    contype AS constraint_type,
    pg_get_constraintdef(oid) AS constraint_definition
FROM pg_constraint
WHERE conrelid = 'public.user_subscriptions'::regclass
ORDER BY contype, conname;

-- Expected constraints:
-- PRIMARY KEY on id
-- UNIQUE on user_id
-- CHECK constraint on plan_type (IN ('free', 'pro'))
-- CHECK constraint on status (IN ('active', 'cancelled', 'expired'))
-- FOREIGN KEY on user_id REFERENCES auth.users

-- ============================================
-- 3. Check RLS policies on user_subscriptions
-- ============================================
SELECT 
    schemaname,
    tablename,
    policyname,
    permissive,
    roles,
    cmd,
    qual,
    with_check
FROM pg_policies
WHERE tablename = 'user_subscriptions';

-- Expected policies:
-- "Users can view their own subscription" (SELECT)
-- "Users can insert their own subscription" (INSERT)
-- "Users can update their own subscription" (UPDATE)

-- ============================================
-- 4. Check if RLS is enabled
-- ============================================
SELECT 
    tablename,
    rowsecurity AS rls_enabled
FROM pg_tables
WHERE schemaname = 'public' 
  AND tablename = 'user_subscriptions';

-- Should return: rls_enabled = true

-- ============================================
-- 5. Check user_usage_stats table structure
-- ============================================
SELECT 
    column_name,
    data_type,
    is_nullable,
    column_default
FROM information_schema.columns
WHERE table_schema = 'public' 
  AND table_name = 'user_usage_stats'
ORDER BY ordinal_position;

-- Expected columns:
-- id (uuid, NOT NULL, PRIMARY KEY)
-- user_id (uuid, NOT NULL, FOREIGN KEY to auth.users)
-- uploads_this_month (integer, nullable, default 0)
-- last_upload_at (timestamptz, nullable)
-- reset_at (timestamptz, nullable)
-- created_at (timestamptz, NOT NULL)
-- updated_at (timestamptz, NOT NULL)

-- ============================================
-- 6. Check triggers
-- ============================================
SELECT 
    trigger_name,
    event_manipulation,
    event_object_table,
    action_statement
FROM information_schema.triggers
WHERE event_object_schema = 'public'
  AND (event_object_table = 'user_subscriptions' 
       OR event_object_table = 'user_usage_stats')
ORDER BY event_object_table, trigger_name;

-- Expected triggers:
-- update_user_subscriptions_updated_at (BEFORE UPDATE)
-- update_user_usage_stats_updated_at (BEFORE UPDATE)
-- on_auth_user_created (AFTER INSERT on auth.users)

-- ============================================
-- 7. Quick validation query
-- ============================================
-- This query should return 1 row with all checks passing
SELECT 
    'user_subscriptions' AS table_name,
    (SELECT COUNT(*) FROM information_schema.columns 
     WHERE table_name = 'user_subscriptions' 
       AND table_schema = 'public') AS column_count,
    (SELECT COUNT(*) FROM pg_policies 
     WHERE tablename = 'user_subscriptions') AS policy_count,
    (SELECT rowsecurity FROM pg_tables 
     WHERE tablename = 'user_subscriptions' 
       AND schemaname = 'public') AS rls_enabled,
    (SELECT COUNT(*) FROM information_schema.columns 
     WHERE table_name = 'user_subscriptions' 
       AND column_name = 'revenue_cat_subscription_id') AS has_revenue_cat_subscription_id;

-- Expected result:
-- column_count: 11 (or 10 if revenue_cat_subscription_id was added separately)
-- policy_count: 3
-- rls_enabled: true
-- has_revenue_cat_subscription_id: 1 ⭐ MUST BE 1!

-- ============================================
-- 8. Sample data check (if you have test data)
-- ============================================
SELECT 
    user_id,
    plan_type,
    status,
    revenue_cat_customer_id,
    revenue_cat_subscription_id,
    created_at,
    updated_at
FROM user_subscriptions
ORDER BY updated_at DESC
LIMIT 10;

-- This will show you actual subscription data
-- Check that:
-- - plan_type is either 'free' or 'pro'
-- - status is either 'active', 'cancelled', or 'expired'
-- - revenue_cat_subscription_id is populated for pro users (or NULL for free users)

