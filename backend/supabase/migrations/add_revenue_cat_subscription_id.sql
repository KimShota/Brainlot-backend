-- Add revenue_cat_subscription_id column to user_subscriptions table
-- This column stores the RevenueCat product identifier for the subscription

ALTER TABLE user_subscriptions
ADD COLUMN IF NOT EXISTS revenue_cat_subscription_id TEXT;

-- Add comment to document the column
COMMENT ON COLUMN user_subscriptions.revenue_cat_subscription_id IS 'RevenueCat product identifier for the active subscription';

