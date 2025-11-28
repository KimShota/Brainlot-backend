-- Rollback script to remove all changes from add_daily_upload_tracking.sql
-- Run this if you want to revert to the original version

-- 1. Drop the new functions
DROP FUNCTION IF EXISTS check_and_reset_daily_uploads_on_login(UUID);
DROP FUNCTION IF EXISTS increment_upload_count(UUID);
DROP FUNCTION IF EXISTS get_user_usage_stats(UUID);

-- 2. Restore the original create_user_subscription_and_stats function
-- Based on your actual database structure
CREATE OR REPLACE FUNCTION create_user_subscription_and_stats()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.user_subscriptions (user_id, plan_type, is_active, status, created_at, updated_at)
  VALUES (NEW.id, 'free', true, 'active', NOW(), NOW())
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.user_usage_stats (user_id, uploads_this_month, last_reset_date, created_at, updated_at)
  VALUES (NEW.id, 0, CURRENT_DATE, NOW(), NOW())
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. Remove the new columns from user_usage_stats
-- Note: PostgreSQL doesn't support IF EXISTS for DROP COLUMN, so we check if column exists first
DO $$ 
BEGIN
    -- Drop uploads_today column if it exists
    IF EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = 'user_usage_stats' 
        AND column_name = 'uploads_today'
    ) THEN
        ALTER TABLE user_usage_stats DROP COLUMN uploads_today;
    END IF;

    -- Drop daily_reset_at column if it exists
    IF EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = 'user_usage_stats' 
        AND column_name = 'daily_reset_at'
    ) THEN
        ALTER TABLE user_usage_stats DROP COLUMN daily_reset_at;
    END IF;

    -- Drop last_login_at column if it exists
    IF EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = 'user_usage_stats' 
        AND column_name = 'last_login_at'
    ) THEN
        ALTER TABLE user_usage_stats DROP COLUMN last_login_at;
    END IF;
END $$;

-- Verification query (optional - run this to confirm rollback)
-- SELECT 
--     column_name,
--     data_type
-- FROM information_schema.columns
-- WHERE table_schema = 'public' 
--   AND table_name = 'user_usage_stats'
-- ORDER BY ordinal_position;

