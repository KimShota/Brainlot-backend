-- Optimize create_user_subscription_and_stats function for daily limit only
-- This function is automatically called when a new user signs up (via trigger)
CREATE OR REPLACE FUNCTION create_user_subscription_and_stats()
RETURNS TRIGGER AS $$
BEGIN
  -- Create free plan subscription for new user
  INSERT INTO public.user_subscriptions (user_id, plan_type, is_active, status, created_at, updated_at)
  VALUES (NEW.id, 'free', true, 'active', NOW(), NOW())
  ON CONFLICT (user_id) DO NOTHING;

  -- Create usage stats for new user (daily limit only)
  INSERT INTO public.user_usage_stats (
    user_id, 
    uploads_today,           -- Daily limit tracking
    daily_reset_at,          -- Daily reset time
    last_login_at,           -- Track last login
    created_at, 
    updated_at
  )
  VALUES (
    NEW.id, 
    0,                                                      -- Start with 0 uploads today
    (date_trunc('day', now()) + interval '1 day')::timestamptz,  -- Reset at next midnight UTC
    now(),                                                  -- Set initial login time
    NOW(), 
    NOW()
  )
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

