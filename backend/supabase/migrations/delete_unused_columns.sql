-- Delete unused columns from user_usage_stats and user_subscriptions tables
-- These columns are no longer used in the current system (daily limit only)

-- ============================================
-- 1. Delete unused columns from user_usage_stats
-- ============================================

-- uploads_this_month: Not used (monthly limit removed, only daily limit now)
ALTER TABLE user_usage_stats 
DROP COLUMN IF EXISTS uploads_this_month;

-- last_reset_date: Not used (replaced by daily_reset_at)
ALTER TABLE user_usage_stats 
DROP COLUMN IF EXISTS last_reset_date;

-- Note: The following columns are KEPT because they are used:
-- - uploads_today: Used for daily limit tracking
-- - daily_reset_at: Used for daily reset time
-- - last_login_at: Used for tracking last login
-- - created_at, updated_at: Standard timestamp columns

-- ============================================
-- 2. user_subscriptions table columns
-- ============================================
-- All columns in user_subscriptions are currently used:
-- - id: Primary key
-- - user_id: Foreign key to auth.users
-- - plan_type: Used to determine free/pro plan
-- - is_active: Used in create_user_subscription_and_stats
-- - status: Used in queries (.eq('status', 'active'))
-- - revenue_cat_customer_id: Used in syncWithSupabase
-- - revenue_cat_subscription_id: Used in syncWithSupabase
-- - created_at, updated_at: Standard timestamp columns
-- 
-- Therefore, NO columns should be deleted from user_subscriptions

