-- Create user_subscriptions table to track user subscription status
CREATE TABLE IF NOT EXISTS user_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    plan_type TEXT NOT NULL CHECK (plan_type IN ('free', 'pro')),
    status TEXT NOT NULL CHECK (status IN ('active', 'cancelled', 'expired')),
    revenue_cat_customer_id TEXT,
    revenue_cat_subscription_id TEXT,
    started_at TIMESTAMPTZ DEFAULT now(),
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(user_id)
);

-- Create user_usage_stats table to track upload counts
CREATE TABLE IF NOT EXISTS user_usage_stats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    uploads_this_month INTEGER DEFAULT 0,
    last_upload_at TIMESTAMPTZ,
    reset_at TIMESTAMPTZ DEFAULT now(),
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(user_id)
);

-- Enable Row Level Security
ALTER TABLE user_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_usage_stats ENABLE ROW LEVEL SECURITY;

-- Policies for user_subscriptions
CREATE POLICY "Users can view their own subscription"
    ON user_subscriptions FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own subscription"
    ON user_subscriptions FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own subscription"
    ON user_subscriptions FOR UPDATE
    USING (auth.uid() = user_id);

-- Policies for user_usage_stats
CREATE POLICY "Users can view their own usage stats"
    ON user_usage_stats FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own usage stats"
    ON user_usage_stats FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own usage stats"
    ON user_usage_stats FOR UPDATE
    USING (auth.uid() = user_id);

-- Function to automatically create free plan for new users
CREATE OR REPLACE FUNCTION create_user_subscription_and_stats()
RETURNS TRIGGER AS $$
BEGIN
    -- Create free plan subscription
    INSERT INTO user_subscriptions (user_id, plan_type, status)
    VALUES (NEW.id, 'free', 'active');
    
    -- Create usage stats
    INSERT INTO user_usage_stats (user_id, uploads_this_month)
    VALUES (NEW.id, 0);
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to create subscription and stats for new users
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION create_user_subscription_and_stats();

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for updated_at
CREATE TRIGGER update_user_subscriptions_updated_at
    BEFORE UPDATE ON user_subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_usage_stats_updated_at
    BEFORE UPDATE ON user_usage_stats
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

