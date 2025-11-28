-- Add daily upload tracking columns to user_usage_stats
ALTER TABLE user_usage_stats 
ADD COLUMN IF NOT EXISTS uploads_today INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS daily_reset_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

-- Set initial daily_reset_at for existing records (next UTC midnight)
UPDATE user_usage_stats 
SET daily_reset_at = (date_trunc('day', now()) + interval '1 day')::timestamptz
WHERE daily_reset_at IS NULL;

-- Function to check and reset daily uploads when user logs in
CREATE OR REPLACE FUNCTION check_and_reset_daily_uploads_on_login(user_id_param UUID)
RETURNS VOID AS $$
DECLARE
    current_reset_at TIMESTAMPTZ;
    now_time TIMESTAMPTZ := now();
BEGIN
    -- Get current reset time
    SELECT daily_reset_at INTO current_reset_at
    FROM user_usage_stats
    WHERE user_id = user_id_param;

    -- If reset time has passed or doesn't exist, reset daily count
    IF current_reset_at IS NULL OR now_time >= current_reset_at THEN
        UPDATE user_usage_stats
        SET 
            uploads_today = 0,
            daily_reset_at = (date_trunc('day', now_time) + interval '1 day')::timestamptz,
            last_login_at = now_time,
            updated_at = now_time
        WHERE user_id = user_id_param;
    ELSE
        -- Just update last_login_at
        UPDATE user_usage_stats
        SET 
            last_login_at = now_time,
            updated_at = now_time
        WHERE user_id = user_id_param;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to safely increment upload counts (with daily reset check)
CREATE OR REPLACE FUNCTION increment_upload_count(user_id_param UUID)
RETURNS VOID AS $$
DECLARE
    current_reset_at TIMESTAMPTZ;
    now_time TIMESTAMPTZ := now();
BEGIN
    -- Get current reset time
    SELECT daily_reset_at INTO current_reset_at
    FROM user_usage_stats
    WHERE user_id = user_id_param;

    -- If reset time has passed, reset daily count first
    IF current_reset_at IS NULL OR now_time >= current_reset_at THEN
        UPDATE user_usage_stats
        SET 
            uploads_today = 1,
            daily_reset_at = (date_trunc('day', now_time) + interval '1 day')::timestamptz,
            updated_at = now_time
        WHERE user_id = user_id_param;
    ELSE
        -- Just increment daily counter
        UPDATE user_usage_stats
        SET 
            uploads_today = COALESCE(uploads_today, 0) + 1,
            updated_at = now_time
        WHERE user_id = user_id_param;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to get user usage stats (with automatic daily reset check)
-- Daily limit only (no monthly tracking)
-- Drop existing function first if return type has changed
DROP FUNCTION IF EXISTS get_user_usage_stats(UUID);

CREATE OR REPLACE FUNCTION get_user_usage_stats(user_id_param UUID)
RETURNS TABLE (
    uploads_today INTEGER,
    daily_reset_at TIMESTAMPTZ,
    last_login_at TIMESTAMPTZ
) AS $$
DECLARE
    current_reset_at TIMESTAMPTZ;
    now_time TIMESTAMPTZ := now();
BEGIN
    -- Get current reset time (explicitly use table alias to avoid ambiguity)
    SELECT uus.daily_reset_at INTO current_reset_at
    FROM user_usage_stats uus
    WHERE uus.user_id = user_id_param;

    -- If reset time has passed, reset daily count
    IF current_reset_at IS NULL OR now_time >= current_reset_at THEN
        UPDATE user_usage_stats
        SET 
            uploads_today = 0,
            daily_reset_at = (date_trunc('day', now_time) + interval '1 day')::timestamptz,
            updated_at = now_time
        WHERE user_id = user_id_param;
    END IF;

    -- Return current stats (daily limit only)
    RETURN QUERY
    SELECT 
        COALESCE(uus.uploads_today, 0)::INTEGER,
        uus.daily_reset_at,
        uus.last_login_at
    FROM user_usage_stats uus
    WHERE uus.user_id = user_id_param;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Update the trigger function to initialize daily_reset_at for new users
-- Daily limit only (no monthly tracking)
CREATE OR REPLACE FUNCTION create_user_subscription_and_stats()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.user_subscriptions (user_id, plan_type, is_active, status, created_at, updated_at)
  VALUES (NEW.id, 'free', true, 'active', NOW(), NOW())
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.user_usage_stats (
    user_id, 
    uploads_today,
    daily_reset_at,
    last_login_at,
    created_at, 
    updated_at
  )
  VALUES (
    NEW.id, 
    0,
    (date_trunc('day', now()) + interval '1 day')::timestamptz,
    now(),
    NOW(), 
    NOW()
  )
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

